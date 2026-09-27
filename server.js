// flick - movies + tv, the way real proxy sites do it (Luke 9/26):
// cinemeta (stremio) for keyless metadata + catalogs, imdb suggestions for
// search, vixsrc for streams - resolved server-side to raw m3u8 and proxied
// same-origin so school filters only ever see our domain. dep-free, lean:
// in-memory caches, no storage at rest, streams are chunked pipes.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36";
const CINEMETA = "https://v3-cinemeta.strem.io";
const VIX = "https://vixsrc.to";

const cache = new Map();
async function cached(key, ttlMs, fn) {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
	const data = await fn();
	cache.set(key, { data, ts: Date.now() });
	if (cache.size > 400) cache.delete(cache.keys().next().value);
	return data;
}
function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); }
function b64(s) { return Buffer.from(s).toString("base64").replace(/=+$/, ""); }
function unb64(s) { return Buffer.from(String(s || ""), "base64").toString(); }

// tmdb <-> imdb maps from vixsrc's own catalog (its api keys off tmdb ids)
async function vixList(kind) {
	return cached("vixlist:" + kind, 6 * 3600 * 1000, async () => {
		const r = await fetch(VIX + "/api/list/" + kind, { headers: { "user-agent": UA, referer: VIX }, signal: AbortSignal.timeout(30000) });
		if (!r.ok) throw new Error("vix list " + r.status);
		const arr = await r.json();
		const byImdb = new Map();
		for (const e of arr) if (e && e.imdb_id && e.tmdb_id) byImdb.set(e.imdb_id, e.tmdb_id);
		return byImdb;
	});
}
async function imdbToTmdb(kind, imdb) { const m = await vixList(kind); return m.get(imdb) || null; }

function shapeMeta(m, playMap) {
	if (!m) return null;
	const imdb = m.imdb_id || m.id;
	return { id: imdb, name: m.name, poster: m.poster ? "/api/flick/img?u=" + b64(m.poster) : "", year: m.year || (m.releaseInfo || "").slice(0, 4), playable: playMap ? playMap.has(imdb) : true };
}

export default async function flick(req, res, route, url, ctx) {
	const R = String(route || "");
	if (R === "ping") return json(res, 200, { ok: true });

	if (R === "trending" && req.method === "GET") {
		try {
			const [movies, series, mvMap, tvMap] = await Promise.all([
				cached("cm:top:movie", 6 * 3600 * 1000, async () => (await (await fetch(CINEMETA + "/catalog/movie/top.json", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) })).json()).metas || []),
				cached("cm:top:series", 6 * 3600 * 1000, async () => (await (await fetch(CINEMETA + "/catalog/series/top.json", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) })).json()).metas || []),
				vixList("movie"), vixList("tv"),
			]);
			return json(res, 200, {
				ok: true,
				movies: movies.map((m) => shapeMeta(m, mvMap)).filter((x) => x && x.playable),
				series: series.map((m) => shapeMeta(m, tvMap)).filter((x) => x && x.playable),
			});
		} catch (e) { return json(res, 502, { error: "metadata failed" }); }
	}

	if (R === "search" && req.method === "GET") {
		const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
		if (!q) return json(res, 400, { error: "missing q" });
		try {
			const slug = q.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
			const d = await cached("imdbsg:" + slug, 3600 * 1000, async () => {
				const r = await fetch("https://v2.sg.media-imdb.com/suggestion/" + slug[0] + "/" + encodeURIComponent(slug) + ".json", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) });
				if (!r.ok) throw new Error("imdb " + r.status);
				return r.json();
			});
			const [mvMap, tvMap] = await Promise.all([vixList("movie"), vixList("tv")]);
			const items = ((d && d.d) || []).filter((x) => x && /^tt\d+$/.test(x.id || "") && (x.qid === "movie" || x.qid === "TV series" || x.qid === "TV mini-series" || x.q === "feature" || x.q === "TV series")).slice(0, 30).map((x) => {
				const isTv = x.qid === "TV series" || x.qid === "TV mini-series" || x.q === "TV series";
				const map = isTv ? tvMap : mvMap;
				return { id: x.id, name: x.l, year: x.y || "", kind: isTv ? "series" : "movie", poster: x.i && x.i.imageUrl ? "/api/flick/img?u=" + b64(x.i.imageUrl) : "", playable: map.has(x.id) };
			}).filter((x) => x.playable);
			return json(res, 200, { ok: true, items });
		} catch (e) { return json(res, 502, { error: "search failed" }); }
	}

	if (R === "meta" && req.method === "GET") {
		const id = String(url.searchParams.get("id") || "");
		const kind = url.searchParams.get("kind") === "series" ? "series" : "movie";
		if (!/^tt\d+$/.test(id)) return json(res, 400, { error: "bad id" });
		try {
			const d = await cached("cm:meta:" + kind + ":" + id, 6 * 3600 * 1000, async () => {
				const r = await fetch(CINEMETA + "/meta/" + kind + "/" + id + ".json", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
				if (!r.ok) throw new Error("meta " + r.status);
				return r.json();
			});
			const m = d && d.meta;
			if (!m) return json(res, 404, { error: "not found" });
			const tmdb = await imdbToTmdb(kind === "series" ? "tv" : "movie", id);
			const out = {
				ok: true, id, kind, tmdb,
				name: m.name, year: m.year || (m.releaseInfo || "").slice(0, 4),
				desc: (m.description || "").slice(0, 600), poster: m.poster ? "/api/flick/img?u=" + b64(m.poster) : "",
				background: m.background ? "/api/flick/img?u=" + b64(m.background) : "",
				genres: m.genres || [], runtime: m.runtime || "", rating: m.imdbRating || "",
			};
			if (kind === "series" && Array.isArray(m.videos)) {
				const eps = {};
				for (const v of m.videos) {
					if (!v || !v.season || !v.episode) continue;
					(eps[v.season] = eps[v.season] || []).push({ e: v.episode, name: v.name || ("episode " + v.episode), thumb: v.thumbnail ? "/api/flick/img?u=" + b64(v.thumbnail) : "" });
				}
				for (const s of Object.keys(eps)) eps[s].sort((a, b) => a.e - b.e);
				out.episodes = eps;
			}
			return json(res, 200, out);
		} catch (e) { return json(res, 502, { error: "metadata failed" }); }
	}

	if (R === "resolve" && req.method === "GET") {
		const tmdb = parseInt(url.searchParams.get("tmdb") || "0") || 0;
		const isTv = url.searchParams.get("kind") === "tv";
		const s = parseInt(url.searchParams.get("s") || "1") || 1, e = parseInt(url.searchParams.get("e") || "1") || 1;
		if (!tmdb) return json(res, 400, { error: "missing tmdb" });
		try {
			// vixsrc chain: api -> embed html -> token+playlist -> master m3u8 (tokens
			// expire in minutes, so this resolves fresh on every play - cache nothing)
			const apiUrl = isTv ? VIX + "/api/tv/" + tmdb + "/" + s + "/" + e : VIX + "/api/movie/" + tmdb;
			const a = await (await fetch(apiUrl, { headers: { "user-agent": UA, referer: VIX, origin: VIX }, signal: AbortSignal.timeout(15000) })).json().catch(() => null);
			if (!a || !a.src) return json(res, 404, { error: "no stream for that one" });
			const embedUrl = new URL(a.src, VIX).href;
			const html = await (await fetch(embedUrl, { headers: { "user-agent": UA, referer: VIX, accept: "text/html" }, signal: AbortSignal.timeout(15000) })).text();
			const token = /token["']\s*:\s*["']([^"']+)/.exec(html)?.[1];
			const expires = /expires["']\s*:\s*["']([^"']+)/.exec(html)?.[1];
			const playlist = /url\s*:\s*["']([^"']+)/.exec(html)?.[1];
			if (!token || !expires || !playlist) return json(res, 502, { error: "stream resolve failed" });
			const m3u8 = playlist + (playlist.includes("?") ? "&" : "?") + "token=" + token + "&expires=" + expires + "&h=1";
			return json(res, 200, { ok: true, playlist: "/api/flick/stream?u=" + b64(m3u8) });
		} catch (e) { return json(res, 502, { error: "stream resolve failed" }); }
	}

	if (R === "stream" && req.method === "GET") {
		const u = unb64(url.searchParams.get("u") || "");
		let host = "";
		try { host = new URL(u).hostname; } catch (e) { return json(res, 400, { error: "bad url" }); }
		// vixsrc + its segment cdns only
		if (!/(^|\.)vixsrc\.to$/.test(host) && !/(^|\.)[a-z0-9-]+\.(boats|bond|cfd|lol|pics|mom|rest|skin|top|xyz)$/i.test(host)) return json(res, 400, { error: "bad url" });
		try {
			const headers = { "user-agent": UA, referer: VIX };
			if (req.headers.range) headers.range = req.headers.range;
			const r = await fetch(u, { headers, redirect: "follow", signal: AbortSignal.timeout(30000) });
			if (!r.ok && r.status !== 206) { res.writeHead(502); return res.end(); }
			const ct = r.headers.get("content-type") || "";
			const isM3U8 = /mpegurl|m3u8/i.test(ct) || /\.m3u8(\?|$)/i.test(u) || /playlist/i.test(u);
			if (isM3U8) {
				// rewrite every uri (segments, keys, audio tracks, variants) through us
				const text = await r.text();
				const out = text.split("\n").map((line) => {
					const rewrite = (val) => {
						const abs = new URL(val, u).href;
						return "/api/flick/stream?u=" + b64(abs);
					};
					if (!line.trim() || line.startsWith("#")) {
						return line.replace(/URI="([^"]+)"/g, (m, v) => 'URI="' + rewrite(v) + '"');
					}
					return rewrite(line.trim());
				}).join("\n");
				res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" });
				return res.end(out);
			}
			const h = { "cache-control": "private, max-age=3600" };
			for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) { const v = r.headers.get(k); if (v) h[k] = v; }
			res.writeHead(r.status === 206 ? 206 : 200, h);
			if (!r.body) return res.end();
			for await (const chunk of r.body) { if (!res.write(chunk)) await new Promise((d) => res.once("drain", d)); }
			return res.end();
		} catch (e) { res.writeHead(502); return res.end(); }
	}

	if (R === "img" && req.method === "GET") {
		const u = unb64(url.searchParams.get("u") || "");
		let host = "";
		try { host = new URL(u).hostname; } catch (e) { return json(res, 400, { error: "bad url" }); }
		if (!/(^|\.)metahub\.space$/.test(host) && !/(^|\.)media-amazon\.com$/.test(host)) return json(res, 400, { error: "bad url" });
		try {
			const r = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
			if (!r.ok) { res.writeHead(502); return res.end(); }
			res.writeHead(200, { "content-type": r.headers.get("content-type") || "image/jpeg", "cache-control": "public, max-age=86400" });
			if (!r.body) return res.end();
			for await (const chunk of r.body) { if (!res.write(chunk)) await new Promise((d) => res.once("drain", d)); }
			return res.end();
		} catch (e) { res.writeHead(502); return res.end(); }
	}

	return json(res, 404, { error: "unknown flick route" });
}
