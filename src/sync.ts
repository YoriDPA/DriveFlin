import { GoogleDrive } from './gdrive';
import { Cipher } from '@fyears/rclone-crypt';
import { toValidUuid } from './index';

// Sync a single series folder directly into the DB (no self-fetch needed)
async function syncSeriesFolder(env: any, gdrive: any, rc: any, libraryId: string, seriesId: string, seriesFolderId: string, seenIds: string[]) {
  const seasonList: any = await gdrive.listFolder(seriesFolderId);
  for (const seasonItem of (seasonList.files || [])) {
    if ((seasonItem.shortcutDetails?.targetMimeType || seasonItem.mimeType) === 'application/vnd.google-apps.folder') {
      let seasonName = seasonItem.name;
      try { seasonName = await rc.decryptFileName(seasonItem.name); } catch(e) {}
      const sMatch = seasonName.match(/S(\d+)|Season\s*(\d+)|Temporada\s*(\d+)/i);
      const seasonNumber = sMatch ? parseInt(sMatch[1] || sMatch[2] || sMatch[3]) : 1;
      const seasonId = `season_${(seasonItem.shortcutDetails?.targetId || seasonItem.id)}`;
      seenIds.push(seasonId);

      await env.DB.prepare(`
        INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, IndexNumber, FolderId, Uuid)
        VALUES (?, ?, ?, 'Season', ?, ?, ?, ?)
        ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, IndexNumber = excluded.IndexNumber, FolderId = excluded.FolderId, Uuid = excluded.Uuid
      `).bind(seasonId, seriesId, libraryId, seasonName, seasonNumber, (seasonItem.shortcutDetails?.targetId || seasonItem.id), toValidUuid(seasonId)).run();

      const epList: any = await gdrive.listFolder((seasonItem.shortcutDetails?.targetId || seasonItem.id));
      for (const ep of (epList.files || [])) {
        if ((ep.shortcutDetails?.targetMimeType || ep.mimeType) === 'application/vnd.google-apps.folder') continue;
        let epName = ep.name;
        try { epName = await rc.decryptFileName(ep.name); } catch(e) {}
        if (!epName.match(/\.(mp4|mkv|avi|webm|m4v|mov|wmv)$/i)) continue;
        const rowEpId = `ep_${(ep.shortcutDetails?.targetId || ep.id)}`;
        seenIds.push(rowEpId);
        
        const epMatch = epName.match(/(?:[Ss]\d+)?\s*[Ee](\d+)|\b\d+x(\d+)\b|\bEp[._\s]*(\d+)\b|(?:^|\D)(\d{1,3})\s*\./i);
        const epNumber = epMatch ? parseInt(epMatch[1] || epMatch[2] || epMatch[3] || epMatch[4]) : 1;
        await env.DB.prepare(`
          INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, IndexNumber, ParentIndexNumber, FileId, EncryptedName, Size, Uuid)
          VALUES (?, ?, ?, 'Episode', ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, IndexNumber = excluded.IndexNumber, ParentIndexNumber = excluded.ParentIndexNumber, FileId = excluded.FileId, EncryptedName = excluded.EncryptedName, Size = excluded.Size, Uuid = excluded.Uuid
        `).bind(rowEpId, seasonId, libraryId, epName, epNumber, seasonNumber, (ep.shortcutDetails?.targetId || ep.id), ep.name, ep.size || 0, toValidUuid(rowEpId)).run();
      }
    } else {
      // File at series root level (no season folder) — treat as S01
      let epName = seasonItem.name;
      try { epName = await rc.decryptFileName(seasonItem.name); } catch(e) {}
      if (!epName.match(/\.(mp4|mkv|avi|webm|m4v|mov|wmv)$/i)) continue;

      const defaultSeasonId = `season_${seriesFolderId}_s1`;
      seenIds.push(defaultSeasonId);
      
      await env.DB.prepare(`
        INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, IndexNumber, FolderId, Uuid)
        VALUES (?, ?, ?, 'Season', 'Season 1', 1, ?, ?)
        ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, IndexNumber = excluded.IndexNumber, FolderId = excluded.FolderId, Uuid = excluded.Uuid
      `).bind(defaultSeasonId, seriesId, libraryId, seriesFolderId, toValidUuid(defaultSeasonId)).run();

      const rowEpId = `ep_${(seasonItem.shortcutDetails?.targetId || seasonItem.id)}`;
      seenIds.push(rowEpId);
      
      const epMatch = epName.match(/(?:[Ss]\d+)?\s*[Ee](\d+)|\b\d+x(\d+)\b|\bEp[._\s]*(\d+)\b|(?:^|\D)(\d{1,3})\s*\./i);
      const epNumber = epMatch ? parseInt(epMatch[1] || epMatch[2] || epMatch[3] || epMatch[4]) : 1;
      await env.DB.prepare(`
        INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, IndexNumber, ParentIndexNumber, FileId, EncryptedName, Size, Uuid)
        VALUES (?, ?, ?, 'Episode', ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, IndexNumber = excluded.IndexNumber, FileId = excluded.FileId, EncryptedName = excluded.EncryptedName, Size = excluded.Size, Uuid = excluded.Uuid
      `).bind(rowEpId, defaultSeasonId, libraryId, epName, epNumber, (seasonItem.shortcutDetails?.targetId || seasonItem.id), seasonItem.name, seasonItem.size || 0, toValidUuid(rowEpId)).run();
    }
  }
}

// Sync a single movie folder directly into the DB (with recursion)
async function syncMovieFolder(env: any, gdrive: any, rc: any, libraryId: string, folderId: string, seenIds: string[], depth: number = 0, pending: any[] = []) {
  if (depth > 3) return;
  const list: any = await gdrive.listFolder(folderId);
  for (const item of (list.files || [])) {
    try {
      if ((item.shortcutDetails?.targetMimeType || item.mimeType) === 'application/vnd.google-apps.folder') {
        await syncMovieFolder(env, gdrive, rc, libraryId, (item.shortcutDetails?.targetId || item.id), seenIds, depth + 1, pending);
      } else {
        let name = item.name;
        try { name = await rc.decryptFileName(item.name); } catch(e) {}
        if (!name.match(/\.(mp4|mkv|avi|webm|m4v|mov|wmv)$/i)) continue;
        const fileId = item.shortcutDetails?.targetId || item.id;
        const rowId = `movie_${fileId}`;
        seenIds.push(rowId);
        pending.push(env.DB.prepare(`
          INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, FileId, EncryptedName, Size, Uuid)
          VALUES (?, ?, ?, 'Movie', ?, ?, ?, ?, ?)
          ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, Size = excluded.Size, FileId = excluded.FileId, EncryptedName = excluded.EncryptedName, Uuid = excluded.Uuid
        `).bind(rowId, libraryId, libraryId, name, fileId, item.name, item.size || 0, toValidUuid(rowId)));
        if (pending.length >= 50) {
          await env.DB.batch(pending.splice(0, pending.length));
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      (seenIds as any).__hadError = true;
      console.error(`Error syncing movie item: ${(err as any)?.message || err}`);
    }
  }
  if (depth === 0 && pending.length) await env.DB.batch(pending.splice(0, pending.length));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sincronização com orçamento de subrequisições + retomada (YoriDPA)
//
// No plano grátis da Cloudflare cada execução só pode fazer ~50 subrequisições.
// Antes, a sync recomeçava sempre da primeira biblioteca, travava no mesmo ponto
// e podia apagar itens "não vistos". Agora:
//  - conta as chamadas ao Drive/TMDB e para ANTES de estourar o limite;
//  - guarda no KV onde parou (biblioteca + série) e continua na próxima rodada;
//  - só apaga itens antigos quando a biblioteca foi lida INTEIRA, sem erros,
//    numa única rodada (nunca apaga por causa de limite ou falha);
//  - busca capas/sinopses (TMDB) primeiro, com parte do orçamento, para elas
//    irem chegando mesmo quando as bibliotecas são grandes.
// Ajuste opcional: variável SYNC_MAX_SUBREQUESTS (padrão 40; no plano pago use 900).
// ─────────────────────────────────────────────────────────────────────────────

class BudgetExceeded extends Error {
  constructor() { super("sync budget exceeded"); this.name = "BudgetExceeded"; }
}

function makeBudget(env: any) {
  const parsed = parseInt(String(env.SYNC_MAX_SUBREQUESTS ?? "").trim(), 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 40;
  let used = 0;
  return {
    limit,
    take(n: number = 1) {
      if (used + n > limit) throw new BudgetExceeded();
      used += n;
    },
    left() { return limit - used; },
    get used() { return used; },
  };
}

const SYNC_CURSOR_KEY = "sync_cursor_v1";

async function readCursor(env: any): Promise<{ lib?: string; idx?: number }> {
  try {
    if (env.DRIVEFLIN_CONFIG?.get) {
      const raw = await env.DRIVEFLIN_CONFIG.get(SYNC_CURSOR_KEY);
      if (raw) return JSON.parse(raw);
    }
  } catch (e) {}
  return {};
}

async function writeCursor(env: any, cursor: { lib: string; idx: number }) {
  try {
    if (env.DRIVEFLIN_CONFIG?.put) await env.DRIVEFLIN_CONFIG.put(SYNC_CURSOR_KEY, JSON.stringify(cursor));
  } catch (e) {
    console.error("[sync] falha ao salvar cursor:", e);
  }
}

async function enrichTmdb(env: any, budget: any, maxItems: number) {
  if (maxItems <= 0) return;
  try {
    const { searchTmdb, getTmdbDetails } = await import('./tmdb');
    const missingMetadata = await env.DB.prepare(
      "SELECT * FROM Items WHERE TmdbId IS NULL AND (Type = 'Movie' OR Type = 'Series') LIMIT ?"
    ).bind(maxItems).all();
    const rows = missingMetadata.results || [];
    if (!rows.length) return;
    console.log(`Enriching up to ${rows.length} items with TMDB metadata...`);
    for (const row of rows) {
      if (budget.left() < 2) break;
      budget.take(1);
      const searchRes = await searchTmdb(env.TMDB_API_KEY, row.Name, row.Type);
      if (searchRes) {
        budget.take(1);
        const tmdbDet = await getTmdbDetails(env.TMDB_API_KEY, searchRes.id, row.Type);
        if (tmdbDet) {
          const mediaInfoStr = JSON.stringify({
            tmdb: {
              id: tmdbDet.id,
              title: tmdbDet.title,
              overview: tmdbDet.overview,
              tagline: tmdbDet.tagline,
              genres: tmdbDet.genres,
              people: tmdbDet.people,
              studios: tmdbDet.studios,
              voteAverage: tmdbDet.voteAverage,
              releaseDate: tmdbDet.releaseDate,
              posterPath: tmdbDet.posterPath,
              backdropPath: tmdbDet.backdropPath,
            }
          });
          await env.DB.prepare(`
            UPDATE Items SET
              TmdbId = ?,
              PrimaryImageFileId = COALESCE(PrimaryImageFileId, ?),
              BackdropImageFileId = COALESCE(BackdropImageFileId, ?),
              Overview = COALESCE(Overview, ?),
              Name = ?,
              MediaInfo = ?
            WHERE Id = ?
          `).bind(
            searchRes.id,
            tmdbDet.posterPath,
            tmdbDet.backdropPath,
            tmdbDet.overview,
            tmdbDet.title || row.Name,
            mediaInfoStr,
            row.Id
          ).run();
        } else {
          await env.DB.prepare("UPDATE Items SET TmdbId = ?, Name = ? WHERE Id = ?").bind(searchRes.id, searchRes.title || row.Name, row.Id).run();
        }
      } else {
        // Não encontrado: marca para não tentar de novo toda hora.
        await env.DB.prepare("UPDATE Items SET TmdbId = ? WHERE Id = ?").bind("-1", row.Id).run();
      }
    }
  } catch (err) {
    if (err instanceof BudgetExceeded) return;
    console.error(`Error auto-fetching TMDB metadata: ${(err as any)?.message || err}`);
  }
}

async function cleanupLibrary(env: any, libraryId: string, seenIds: string[]) {
  if (!seenIds.length) return;
  const allLibItems: any = await env.DB.prepare("SELECT Id FROM Items WHERE LibraryId = ?").bind(libraryId).all();
  const seenSet = new Set(seenIds);
  const toDelete = (allLibItems.results || []).map((r: any) => r.Id).filter((id: string) => !seenSet.has(id));
  if (toDelete.length > 0) {
    console.log(`Deleting ${toDelete.length} stale items from library ${libraryId}`);
    for (let i = 0; i < toDelete.length; i += 50) {
      const chunk = toDelete.slice(i, i + 50);
      const chunkPlaceholders = chunk.map(() => '?').join(',');
      await env.DB.prepare(`DELETE FROM Items WHERE Id IN (${chunkPlaceholders})`).bind(...chunk).run();
    }
  }
}

const isFolder = (f: any) => (f.shortcutDetails?.targetMimeType || f.mimeType) === 'application/vnd.google-apps.folder';

export async function runSync(env: any) {
  const gdrive = new GoogleDrive(env);
  const rc = new Cipher('base32');
  rc.dirNameEncrypt = false;
  if (env.RCLONE_PASS) {
    await rc.key(env.RCLONE_PASS, env.RCLONE_SALT || '');
  }

  const budget = makeBudget(env);
  // Cada listagem de pasta do Drive conta como 1 subrequisição.
  const origList = gdrive.listFolder.bind(gdrive);
  (gdrive as any).listFolder = async (id: string) => { budget.take(1); return origList(id); };

  try {
    budget.take(1); // renovação do token do Google
  } catch (e) {}

  // 1) Capas/sinopses primeiro, com até metade do orçamento (2 chamadas por item).
  const enrichItems = Math.min(50, Math.floor((budget.left() / 2) / 2));
  await enrichTmdb(env, budget, enrichItems);

  // 2) Bibliotecas, continuando de onde parou na rodada anterior.
  const { results } = await env.DB.prepare("SELECT * FROM Libraries ORDER BY Id").all();
  const libraries: any[] = results || [];
  if (!libraries.length) return { success: true };

  const cursor = await readCursor(env);
  let startPos = Math.max(0, libraries.findIndex((l) => l.Id === cursor.lib));
  let startIdx = libraries[startPos]?.Id === cursor.lib ? Math.max(0, Number(cursor.idx) || 0) : 0;

  for (let p = 0; p < libraries.length; p++) {
    const pos = (startPos + p) % libraries.length;
    const lib = libraries[pos];
    const nextLib = libraries[(pos + 1) % libraries.length];
    const idx0 = p === 0 ? startIdx : 0;
    let progress = idx0;
    let hadError = false;
    const seenIds: string[] = [];

    try {
      const libraryId = lib.Id;
      const libraryFolderId = lib.FolderId;
      if (!libraryFolderId || (libraryFolderId === "root" && gdrive.teamDriveId)) {
        await writeCursor(env, { lib: nextLib.Id, idx: 0 });
        continue;
      }

      const isMovieLib = (lib.CollectionType === 'movies') || lib.Name.toLowerCase().includes('filme');
      const isTvLib = (lib.CollectionType === 'tvshows') || lib.Name.toLowerCase().includes('serie');
      const isMusicLib = (lib.CollectionType === 'music') || lib.Name.toLowerCase().includes('musica');

      if (isTvLib) {
        const topList: any = await gdrive.listFolder(libraryFolderId);
        const seriesFolders = (topList?.files || [])
          .filter(isFolder)
          .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));

        for (let i = idx0; i < seriesFolders.length; i++) {
          const seriesFolder = seriesFolders[i];
          let seriesName = seriesFolder.name;
          try { seriesName = await rc.decryptFileName(seriesFolder.name); } catch (e) {}
          if (/^S\d+/i.test(seriesName) || /^Season/i.test(seriesName) || /^Temporada/i.test(seriesName)) { progress = i + 1; continue; }

          const folderId = seriesFolder.shortcutDetails?.targetId || seriesFolder.id;
          const seriesId = `series_${folderId}`;
          seenIds.push(seriesId);

          await env.DB.prepare(`
            INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, FolderId, Uuid)
            VALUES (?, ?, ?, 'Series', ?, ?, ?)
            ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, FolderId = excluded.FolderId, Uuid = excluded.Uuid
          `).bind(seriesId, libraryId, libraryId, seriesName, folderId, toValidUuid(seriesId)).run();

          try {
            await syncSeriesFolder(env, gdrive, rc, libraryId, seriesId, folderId, seenIds);
          } catch (err) {
            if (err instanceof BudgetExceeded) throw err;
            hadError = true;
            console.error(`Error syncing series ${seriesName}: ${(err as any)?.message || err}`);
          }
          progress = i + 1;
          // Salva o progresso de tempos em tempos (se a execução for cortada, não perde tudo).
          if (progress % 5 === 0) await writeCursor(env, { lib: lib.Id, idx: progress });
        }
      } else if (isMovieLib) {
        await syncMovieFolder(env, gdrive, rc, libraryId, libraryFolderId, seenIds);
      } else if (isMusicLib) {
        const topList: any = await gdrive.listFolder(libraryFolderId);
        for (const item of (topList?.files || [])) {
          try {
            let name = item.name;
            try { name = await rc.decryptFileName(item.name); } catch (e) {}
            if (!name.match(/\.(mp3|flac|m4a|ogg|wav|aac)$/i)) continue;
            const rowId = `audio_${(item.shortcutDetails?.targetId || item.id)}`;
            seenIds.push(rowId);
            await env.DB.prepare(`
              INSERT INTO Items (Id, ParentId, LibraryId, Type, Name, FileId, EncryptedName, Size, Uuid)
              VALUES (?, ?, ?, 'Audio', ?, ?, ?, ?, ?)
              ON CONFLICT(Id) DO UPDATE SET Name = CASE WHEN Items.TmdbId IS NULL THEN excluded.Name ELSE Items.Name END, Size = excluded.Size, FileId = excluded.FileId, EncryptedName = excluded.EncryptedName, Uuid = excluded.Uuid
            `).bind(rowId, libraryId, libraryId, name, (item.shortcutDetails?.targetId || item.id), item.name, item.size || 0, toValidUuid(rowId)).run();
          } catch (err) {
            hadError = true;
            console.error(`Error syncing audio item:`, err);
          }
        }
      }

      // Só limpa quando a biblioteca foi lida inteira, do começo, sem erros.
      if ((seenIds as any).__hadError) hadError = true;
      if (idx0 === 0 && !hadError) {
        await cleanupLibrary(env, libraryId, seenIds);
      }
      await writeCursor(env, { lib: nextLib.Id, idx: 0 });
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        console.log(`[sync] limite da rodada atingido em "${lib.Name}" (item ${progress}); continua na próxima.`);
        await writeCursor(env, { lib: lib.Id, idx: progress });
        break;
      }
      console.error(`Error syncing library ${lib.Id}: ${(err as any)?.message || err}`);
      await writeCursor(env, { lib: nextLib.Id, idx: 0 });
    }
  }

  // 3) Sobrou orçamento? Usa para mais capas.
  if (budget.left() >= 4) {
    await enrichTmdb(env, budget, Math.min(50, Math.floor(budget.left() / 2)));
  }

  return { success: true };
}
