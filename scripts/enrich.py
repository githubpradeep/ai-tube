#!/usr/bin/env python3
"""Fill duration, channel, and publish date for the curated catalog.

Reads data/seed.json, caches YouTube watch-page metadata in
data/.meta_cache.json, writes data/catalog.json.
"""

import json
import re
import ssl
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "data" / "seed.json"
CACHE = ROOT / "data" / ".meta_cache.json"
OUT = ROOT / "data" / "catalog.json"

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


def grab(html, key):
    match = re.search(rf'{re.escape(key)}":"(.*?)"', html)
    if not match:
        return None
    return json.loads(f'"{match.group(1)}"')


def fetch_one(video_id):
    url = f"https://www.youtube.com/watch?v={video_id}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=25, context=ctx) as response:
        html = response.read().decode("utf-8", "replace")
    seconds = grab(html, "lengthSeconds")
    published = grab(html, "publishDate") or grab(html, "uploadDate")
    channel = grab(html, "ownerChannelName")
    if not seconds or not channel:
        raise RuntimeError(f"missing metadata for {video_id}")
    return {
        "durationSec": int(seconds),
        "published": published[:10] if published else None,
        "channel": channel,
    }


def main():
    seed = json.loads(SEED.read_text())
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    missing = [video["id"] for video in seed["videos"] if video["id"] not in cache]

    if missing:
        print(f"fetching {len(missing)} videos")
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(fetch_one, video_id): video_id for video_id in missing}
            for future in as_completed(futures):
                video_id = futures[future]
                try:
                    cache[video_id] = future.result()
                    print(f"  ok  {video_id}  {cache[video_id]['durationSec']:>5}s  {cache[video_id]['channel']}")
                except Exception as error:
                    print(f"  FAIL {video_id}: {error}")
        CACHE.write_text(json.dumps(cache, indent=2))

    videos = []
    for video in seed["videos"]:
        meta = cache.get(video["id"])
        if not meta:
            print(f"dropping {video['id']} (no metadata)")
            continue
        # Lab release teasers under 75s are ads. Keep them out.
        if video["kind"] == "release" and meta["durationSec"] < 180:
            print(f"dropping short release {video['id']} ({meta['durationSec']}s) {video['label']}")
            continue
        merged = {**video, **meta}
        if video.get("channel"):
            merged["channel"] = video["channel"]
        videos.append(merged)

    tracks_path = ROOT / "data" / "tracks.json"
    tracks = json.loads(tracks_path.read_text()) if tracks_path.exists() else []
    known = {video["id"] for video in videos}
    for track in tracks:
        for stage in track.get("stages", []):
            missing = [vid for vid in stage.get("videos", []) if vid not in known]
            if missing:
                print(f"track {track['id']} / {stage['title']} missing {missing}")

    catalog = {
        "title": seed["title"],
        "updated": seed["updated"],
        "startHere": seed["startHere"],
        "topics": seed["topics"],
        "series": seed["series"],
        "tracks": tracks,
        "videos": videos,
    }
    OUT.write_text(json.dumps(catalog, indent=2) + "\n")
    print(f"\n{len(videos)} videos -> {OUT}")
    print(f"{'kind':<10} {'min':>6}  channel / label")
    for video in videos:
        minutes = video["durationSec"] / 60
        print(f"{video['kind']:<10} {minutes:6.1f}  {video['channel'][:28]:<28}  {video['label']}")


if __name__ == "__main__":
    main()
