// ─────────────────────────────────────────────────────────────────────────────
// Leitura das faixas (áudio/legenda/vídeo) de arquivos MKV direto do Google Drive
// (YoriDPA). Baixa só o começo do arquivo, lê a lista de faixas do Matroska e
// devolve no mesmo formato do ffprobe, que o DriveFlin já sabe exibir.
// Assim o menu de idioma aparece nos apps e o áudio em português vira o padrão.
// ─────────────────────────────────────────────────────────────────────────────

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  CodecID: 0x86,
  Name: 0x536e,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  Channels: 0x9f,
  SamplingFrequency: 0xb5,
  Cluster: 0x1f43b675,
};

function readVint(buf: Uint8Array, pos: number, keepMarker: boolean): { value: number; len: number; unknown: boolean } | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
  if (len > 8 || pos + len > buf.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

type El = { id: number; start: number; dataStart: number; size: number; end: number; unknown: boolean };

function readElement(buf: Uint8Array, pos: number, limit: number): El | null {
  const id = readVint(buf, pos, true);
  if (!id) return null;
  const size = readVint(buf, pos + id.len, false);
  if (!size) return null;
  const dataStart = pos + id.len + size.len;
  const end = size.unknown ? limit : Math.min(limit, dataStart + size.value);
  return { id: id.value, start: pos, dataStart, size: size.value, end, unknown: size.unknown };
}

function children(buf: Uint8Array, start: number, end: number): El[] {
  const out: El[] = [];
  let pos = start;
  while (pos < end) {
    const el = readElement(buf, pos, end);
    if (!el || el.dataStart > end) break;
    out.push(el);
    if (el.unknown) break;
    pos = el.dataStart + el.size;
  }
  return out;
}

const uint = (buf: Uint8Array, el: El) => { let v = 0; for (let i = el.dataStart; i < el.end; i++) v = v * 256 + buf[i]; return v; };
const str = (buf: Uint8Array, el: El) => new TextDecoder().decode(buf.subarray(el.dataStart, el.end)).replace(/\0+$/, "");
const float = (buf: Uint8Array, el: El) => {
  const dv = new DataView(buf.buffer, buf.byteOffset + el.dataStart, el.end - el.dataStart);
  return el.end - el.dataStart === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
};

const CODECS: Record<string, string> = {
  "V_MPEG4/ISO/AVC": "h264", "V_MPEGH/ISO/HEVC": "hevc", "V_AV1": "av1", "V_VP9": "vp9", "V_VP8": "vp8",
  "V_MPEG2": "mpeg2video", "V_MPEG4/ISO/ASP": "mpeg4", "V_MS/VFW/FOURCC": "mpeg4",
  "A_AAC": "aac", "A_AC3": "ac3", "A_EAC3": "eac3", "A_DTS": "dts", "A_TRUEHD": "truehd", "A_OPUS": "opus",
  "A_VORBIS": "vorbis", "A_FLAC": "flac", "A_MPEG/L3": "mp3", "A_MPEG/L2": "mp2", "A_PCM/INT/LIT": "pcm_s16le",
  "S_TEXT/UTF8": "subrip", "S_TEXT/ASS": "ass", "S_TEXT/SSA": "ssa", "S_HDMV/PGS": "hdmv_pgs_subtitle",
  "S_VOBSUB": "dvd_subtitle", "S_TEXT/WEBVTT": "webvtt",
};

function codecName(id: string): string {
  if (CODECS[id]) return CODECS[id];
  if (id.startsWith("A_AAC")) return "aac";
  if (id.startsWith("A_DTS")) return "dts";
  if (id.startsWith("A_PCM")) return "pcm_s16le";
  return id.replace(/^[AVS]_/, "").toLowerCase();
}

/** Converte idioma do Matroska (ISO 639-2 ou BCP47) para código de 3 letras. */
function normLang(lang: string | undefined, bcp47: string | undefined): string {
  const b = (bcp47 || "").toLowerCase();
  if (b) {
    const base = b.split("-")[0];
    const map2: Record<string, string> = { pt: "por", en: "eng", es: "spa", ja: "jpn", fr: "fre", de: "ger", it: "ita", ko: "kor", zh: "chi", ru: "rus" };
    if (map2[base]) return map2[base];
    if (base.length === 3) return base;
  }
  const l = (lang || "eng").toLowerCase(); // padrão do Matroska é "eng" quando ausente
  if (l === "pob" || l === "pt-br") return "por";
  return l;
}

const isPortuguese = (s: any) => s.tags?.language === "por" || /portugu|dublad|pt-?br|brasil/i.test(s.tags?.title || "");

/** Lê o buffer (começo do arquivo). Retorna streams, ou {needOffset} se as faixas estiverem mais adiante. */
export function parseMkv(buf: Uint8Array): { format: any; streams: any[] } | { needOffset: number } | null {
  const top = children(buf, 0, buf.length);
  const ebml = top.find((e) => e.id === ID.EBML);
  const seg = top.find((e) => e.id === ID.Segment);
  if (!ebml || !seg) return null;

  let tracksEl: El | undefined;
  let infoEl: El | undefined;
  let tracksSeekPos: number | undefined;

  for (const el of children(buf, seg.dataStart, seg.end)) {
    if (el.id === ID.Cluster) break;
    if (el.id === ID.Tracks) tracksEl = el;
    else if (el.id === ID.Info) infoEl = el;
    else if (el.id === ID.SeekHead) {
      for (const seek of children(buf, el.dataStart, el.end)) {
        if (seek.id !== ID.Seek) continue;
        const parts = children(buf, seek.dataStart, seek.end);
        const sid = parts.find((p) => p.id === ID.SeekID);
        const spos = parts.find((p) => p.id === ID.SeekPosition);
        if (sid && spos && uint(buf, sid) === ID.Tracks) tracksSeekPos = seg.dataStart + uint(buf, spos);
      }
    }
    if (tracksEl && infoEl) break;
  }

  if (!tracksEl || tracksEl.end - tracksEl.dataStart < tracksEl.size) {
    if (tracksSeekPos !== undefined && tracksSeekPos >= buf.length - 64) return { needOffset: tracksSeekPos };
    if (!tracksEl) return null;
  }

  let duration: number | undefined;
  if (infoEl) {
    let scale = 1000000;
    let dur: number | undefined;
    for (const p of children(buf, infoEl.dataStart, infoEl.end)) {
      if (p.id === ID.TimecodeScale) scale = uint(buf, p);
      if (p.id === ID.Duration) dur = float(buf, p);
    }
    if (dur) duration = (dur * scale) / 1e9;
  }

  const streams: any[] = [];
  for (const te of children(buf, tracksEl.dataStart, tracksEl.end)) {
    if (te.id !== ID.TrackEntry) continue;
    const t: any = { flagDefault: 1, flagForced: 0 };
    for (const p of children(buf, te.dataStart, te.end)) {
      switch (p.id) {
        case ID.TrackType: t.type = uint(buf, p); break;
        case ID.FlagDefault: t.flagDefault = uint(buf, p); break;
        case ID.FlagForced: t.flagForced = uint(buf, p); break;
        case ID.CodecID: t.codec = str(buf, p); break;
        case ID.Name: t.name = str(buf, p); break;
        case ID.Language: t.lang = str(buf, p); break;
        case ID.LanguageBCP47: t.bcp47 = str(buf, p); break;
        case ID.Video:
          for (const v of children(buf, p.dataStart, p.end)) {
            if (v.id === ID.PixelWidth) t.width = uint(buf, v);
            if (v.id === ID.PixelHeight) t.height = uint(buf, v);
          }
          break;
        case ID.Audio:
          for (const a of children(buf, p.dataStart, p.end)) {
            if (a.id === ID.Channels) t.channels = uint(buf, a);
            if (a.id === ID.SamplingFrequency) t.sampleRate = Math.round(float(buf, a));
          }
          break;
      }
    }
    const codec_type = t.type === 1 ? "video" : t.type === 2 ? "audio" : t.type === 17 ? "subtitle" : null;
    if (!codec_type) continue;
    const s: any = {
      index: streams.length,
      codec_type,
      codec_name: codecName(t.codec || ""),
      disposition: { default: t.flagDefault ? 1 : 0, forced: t.flagForced ? 1 : 0 },
      tags: { language: normLang(t.lang, t.bcp47), ...(t.name ? { title: t.name } : {}) },
    };
    if (codec_type === "video") { s.width = t.width; s.height = t.height; }
    if (codec_type === "audio") {
      s.channels = t.channels || 2;
      s.channel_layout = s.channels === 6 ? "5.1" : s.channels === 8 ? "7.1" : s.channels === 1 ? "mono" : "stereo";
      if (t.sampleRate) s.sample_rate = String(t.sampleRate);
    }
    streams.push(s);
  }
  if (!streams.length) return null;

  // Português como áudio padrão (quando existir).
  const audios = streams.filter((s) => s.codec_type === "audio");
  const pt = audios.find(isPortuguese);
  if (pt) audios.forEach((a) => (a.disposition.default = a === pt ? 1 : 0));
  else if (audios.length && !audios.some((a) => a.disposition.default)) audios[0].disposition.default = 1;

  // Legenda: nenhuma ligada por padrão, exceto legenda forçada em português quando não há áudio em português.
  for (const s of streams.filter((x) => x.codec_type === "subtitle")) {
    s.disposition.default = s.disposition.forced && isPortuguese(s) && !pt ? 1 : 0;
  }

  return {
    format: { format_name: "matroska,webm", ...(duration ? { duration: String(duration) } : {}), probed_by: "driveflin-mkvprobe" },
    streams,
  };
}

/** Baixa o começo do arquivo no Drive e lê as faixas. Usa 1 ou 2 subrequisições. */
export async function probeDriveMkv(token: string, fileId: string, take?: () => void): Promise<{ format: any; streams: any[] } | null> {
  const get = async (from: number, to: number) => {
    take?.();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}`, Range: `bytes=${from}-${to}` },
    });
    if (!res.ok && res.status !== 206) throw new Error(`probe HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  const head = await get(0, 1024 * 1024 - 1);
  const r = parseMkv(head);
  if (!r) return null;
  if ("needOffset" in r) {
    const part = await get(r.needOffset, r.needOffset + 256 * 1024 - 1);
    // Monta um buffer "falso" só com EBML + Segment apontando para as faixas.
    const segPos = (() => {
      const top = children(head, 0, head.length);
      return top.find((e) => e.id === ID.Segment);
    })();
    if (!segPos) return null;
    const fake = new Uint8Array(segPos.dataStart + part.length);
    fake.set(head.subarray(0, segPos.dataStart), 0);
    fake.set(part, segPos.dataStart);
    // Ajusta o tamanho do Segment para "desconhecido" para não cortar a leitura.
    const r2 = parseMkv(fake);
    return r2 && !("needOffset" in r2) ? r2 : null;
  }
  return r;
}
