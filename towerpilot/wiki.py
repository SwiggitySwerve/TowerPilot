"""Names-only game vocabulary, OCR fuzzy matcher, and on-demand Fandom MediaWiki fetcher.

Ships zero game images and zero hand-authored patch numbers. Live wiki page
text is fetched on demand over HTTPS (stdlib urllib) and cached locally in
git-ignored `data/wiki_cache.json`.
"""
from __future__ import annotations

import difflib
import json
import os
import re
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WIKI_CACHE_PATH = ROOT / "data" / "wiki_cache.json"
WIKI_API_URL = "https://the-tower-idle-tower-defense.fandom.com/api.php"
WIKI_PAGE_BASE = "https://the-tower-idle-tower-defense.fandom.com/wiki/"


@dataclass(frozen=True)
class IndexItem:
    slug: str
    name: str
    category: str
    aliases: tuple[str, ...]
    wiki_page: str
    highlight: str
    slot: str = ""
    rarity: str = ""


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")


# --- Verified names-only vocabulary (zero stats, zero images) ------------

_CARDS: tuple[tuple[str, str], ...] = (
    # Common (12)
    ("Damage", "common"),
    ("Attack Speed", "common"),
    ("Health", "common"),
    ("Health Regen", "common"),
    ("Range", "common"),
    ("Cash", "common"),
    ("Coins", "common"),
    ("Slow Aura", "common"),
    ("Critical Chance", "common"),
    ("Enemy Balance", "common"),
    ("Extra Defense", "common"),
    ("Fortress", "common"),
    # Rare (9)
    ("Free Upgrades", "rare"),
    ("Extra Orb", "rare"),
    ("Plasma Cannon", "rare"),
    ("Critical Coin", "rare"),
    ("Wave Skip", "rare"),
    ("Intro Sprint", "rare"),
    ("Land Mine Stun", "rare"),
    ("Recovery Package Chance", "rare"),
    ("Cells", "rare"),
    # Epic (10)
    ("Death Ray", "epic"),
    ("Energy Net", "epic"),
    ("Super Tower", "epic"),
    ("Second Wind", "epic"),
    ("Demon Mode", "epic"),
    ("Energy Shield", "epic"),
    ("Wave Accelerator", "epic"),
    ("Berserker", "epic"),
    ("Ultimate Crit", "epic"),
    ("Nuke", "epic"),
    ("Area of Effect", "epic"),
)

_CARD_NAMES: tuple[str, ...] = tuple(name for name, _ in _CARDS)

_MODULES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    # Cannon (6)
    ("Amplifying Strike", "cannon", ("AS",)),
    ("Astral Deliverance", "cannon", ("AD",)),
    ("Being Annihilator", "cannon", ("BA",)),
    ("Death Penalty", "cannon", ("DP",)),
    ("Havoc Bringer", "cannon", ("HB",)),
    ("Shrink Ray", "cannon", ("SR",)),
    # Armor (6)
    ("Anti-Cube Portal", "armor", ("ACP",)),
    ("Negative Mass Projector", "armor", ("NMP",)),
    ("Orbital Augment", "armor", ("OA",)),
    ("Sharp Fortitude", "armor", ("SF",)),
    ("Space Displacer", "armor", ("SD",)),
    ("Wormhole Redirector", "armor", ("WR",)),
    # Generator (6)
    ("Black Hole Digestor", "generator", ("BHD",)),
    ("Galaxy Compressor", "generator", ("GC", "GCOMP")),
    ("Project Funding", "generator", ("PF",)),
    ("Pulsar Harvester", "generator", ("PH",)),
    ("Restorative Bonus", "generator", ("RB",)),
    ("Singularity Harness", "generator", ("SH",)),
    # Core (7)
    ("Dimension Core", "core", ("DC",)),
    ("Harmony Conductor", "core", ("HC",)),
    ("Magnetic Hook", "core", ("MH",)),
    ("Multiverse Nexus", "core", ("MVN",)),
    ("Om Chip", "core", ("OC",)),
    ("Primordial Collapse", "core", ("PC",)),
    ("Solar Dyson Sphere", "core", ("SDS",)),
)

_UWS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Black Hole", ("BH",)),
    ("Chain Lightning", ("CL",)),
    ("Chrono Field", ("CF",)),
    ("Death Wave", ("DW",)),
    ("Golden Tower", ("GT",)),
    ("Inner Land Mines", ("ILM",)),
    ("Poison Swamp", ("PS",)),
    ("Smart Missiles", ("SM",)),
    ("Spotlight", ("SL",)),
)

# Ultimate Weapon Plus (UW+) abilities unlocked after owning all 9 base UWs (Lv. 0..10 each)
_UW_PLUS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("Consume", "Black Hole", ("BH+",)),
    ("Smite", "Chain Lightning", ("CL+",)),
    ("Chrono Loop", "Chrono Field", ("CF+",)),
    ("Kill Wall", "Death Wave", ("DW+",)),
    ("Golden Combo", "Golden Tower", ("GT+",)),
    ("Charged Mines", "Inner Land Mines", ("ILM+",)),
    ("Death Creep", "Poison Swamp", ("PS+",)),
    ("Cover Fire", "Smart Missiles", ("SM+",)),
    ("Light Range", "Spotlight", ("SL+",)),
)

_WORKSHOP_UPGRADES: tuple[tuple[str, str, str, tuple[str, ...]], ...] = (
    # Attack (17)
    ("Damage", "attack", "Damage", ()),
    ("Attack Speed", "attack", "Attack Speed", ()),
    ("Critical Chance", "attack", "Critical Hits", ()),
    ("Critical Factor", "attack", "Critical Hits", ()),
    ("Range", "attack", "Range", ()),
    ("Damage / Meter", "attack", "Damage Per Meter", ("Damage/Meter", "Damage Per Meter", "Damage / m")),
    ("Multishot Chance", "attack", "Multishot", ()),
    ("Multishot Targets", "attack", "Multishot", ()),
    ("Rapid Fire Chance", "attack", "Rapid Fire", ()),
    ("Rapid Fire Duration", "attack", "Rapid Fire", ()),
    ("Bounce Shot Chance", "attack", "Bounce Shot", ()),
    ("Bounce Shot Targets", "attack", "Bounce Shot", ()),
    ("Bounce Shot Range", "attack", "Bounce Shot", ()),
    ("Super Crit Chance", "attack", "Super Critical", ()),
    ("Super Crit Mult", "attack", "Super Critical", ("Super Crit Multiplier",)),
    ("Rend Armor Chance", "attack", "Rend Armor", ()),
    ("Rend Armor Mult", "attack", "Rend Armor", ("Rend Armor Multiplier",)),
    # Defense (18)
    ("Health", "defense", "Health", ()),
    ("Health Regen", "defense", "Health Regen", ()),
    ("Defense %", "defense", "Defense Percent", ("Defense Percent",)),
    ("Defense Absolute", "defense", "Defense Absolute", ()),
    ("Thorns Damage", "defense", "Thorn Damage", ("Thorn Damage", "Thorns")),
    ("Lifesteal", "defense", "Lifesteal", ()),
    ("Knockback Chance", "defense", "Knockback", ()),
    ("Knockback Force", "defense", "Knockback", ()),
    ("Orb Speed", "defense", "Orbs", ()),
    ("Orbs", "defense", "Orbs", ()),
    ("Shockwave Size", "defense", "Shockwave", ()),
    ("Shockwave Frequency", "defense", "Shockwave", ()),
    ("Land Mine Chance", "defense", "Land Mine", ()),
    ("Land Mine Damage", "defense", "Land Mine", ()),
    ("Land Mine Radius", "defense", "Land Mine", ()),
    ("Death Defy", "defense", "Death Defy", ()),
    ("Wall Health", "defense", "Wall", ()),
    ("Wall Rebuild", "defense", "Wall", ()),
    # Utility (13)
    ("Cash Bonus", "utility", "Cash Bonus", ()),
    ("Cash / Wave", "utility", "Cash Per Wave", ("Cash/Wave", "Cash Per Wave")),
    ("Coins / Kill Bonus", "utility", "Coins Per Kill Bonus", ("Coins/Kill Bonus", "Coins Per Kill Bonus")),
    ("Coins / Wave", "utility", "Coins Per Wave", ("Coins/Wave", "Coins Per Wave")),
    ("Free Attack Upgrade", "utility", "Free Upgrades", ()),
    ("Free Defense Upgrade", "utility", "Free Upgrades", ()),
    ("Free Utility Upgrade", "utility", "Free Upgrades", ()),
    ("Interest / Wave", "utility", "Interest", ("Interest/Wave", "Interest Per Wave")),
    ("Recovery Amount", "utility", "Recovery Packages", ()),
    ("Max Recovery", "utility", "Recovery Packages", ()),
    ("Package Chance", "utility", "Recovery Packages", ("Recovery Package Chance",)),
    ("Enemy Attack Level Skip", "utility", "Enemy Level Skip", ("EALS",)),
    ("Enemy Health Level Skip", "utility", "Enemy Level Skip", ("EHLS",)),
)

_ENEMIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Basic", ()),
    ("Fast", ()),
    ("Tank", ()),
    ("Ranged", ()),
    ("Boss", ()),
    ("Protector", ()),
    ("Vampire", ()),
    ("Ray", ()),
    ("Scatter", ()),
    ("Saboteur", ()),
    ("Commander", ()),
    ("Overcharge", ()),
)

_TOPICS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("Cards", "Cards", ()),
    ("Modules", "Modules", ()),
    ("Ultimate Weapons", "Ultimate Weapons", ("UW", "UWs")),
    ("Enemies", "Enemies", ("Elites",)),
    ("Tiers", "Tiers", ()),
    ("Perks", "Perks", ()),
    ("Guardian", "Guardian", ("Bots",)),
)


def _build_index() -> list[IndexItem]:
    items: list[IndexItem] = []
    for name, rarity in _CARDS:
        items.append(IndexItem(f"card:{_slugify(name)}", name, "card", (), "Cards", name, rarity=rarity))
    for name, slot, aliases in _MODULES:
        items.append(IndexItem(f"module:{_slugify(name)}", name, "module", aliases, "Epic Module Unique Effect", name, slot=slot))
    for name, aliases in _UWS:
        items.append(IndexItem(f"uw:{_slugify(name)}", name, "uw", aliases, name, name))
    for name, parent_uw, aliases in _UW_PLUS:
        items.append(
            IndexItem(
                f"uw_plus:{_slugify(name)}",
                name,
                "uw_plus",
                aliases,
                "Ultimate Weapons/Ultimate Weapon Plus",
                name,
                slot=parent_uw,
            )
        )
    for name, slot, page, aliases in _WORKSHOP_UPGRADES:
        items.append(IndexItem(f"workshop:{_slugify(name)}", name, "workshop", aliases, page, name, slot=slot))
    for name, aliases in _ENEMIES:
        items.append(IndexItem(f"enemy:{_slugify(name)}", name, "enemy", aliases, "Enemies", name))
    for tier in range(1, 25):
        items.append(IndexItem(f"tier:{tier}", f"Tier {tier}", "tier", (f"T{tier}",), "Tiers", f"Tier {tier}"))
    for name, page, aliases in _TOPICS:
        items.append(IndexItem(f"topic:{_slugify(name)}", name, "topic", aliases, page, name))
    return items


INDEX: tuple[IndexItem, ...] = tuple(_build_index())
BY_SLUG: dict[str, IndexItem] = {item.slug: item for item in INDEX}
_LOOKUP_BY_CAT: dict[str, dict[str, IndexItem]] = {}
for _item in INDEX:
    cat_map = _LOOKUP_BY_CAT.setdefault(_item.category, {})
    for _key in (_item.name.lower(), _item.name.lower().replace("-", " "), _item.slug.lower(), *(a.lower() for a in _item.aliases)):
        cat_map[_key] = _item

_CATEGORY_PRIORITY = ("module", "uw", "uw_plus", "card", "workshop", "enemy", "tier", "topic")


def match_name(
    text: str,
    *,
    category: str | None = None,
    exact_only: bool = False,
    high: float = 0.86,
    floor: float = 0.66,
    margin: float = 0.06,
    strong_margin: float = 0.12,
) -> IndexItem | None:
    """Resolve an OCR string, slug, display name, or community abbreviation to an IndexItem."""
    cleaned = " ".join((text or "").strip().split())
    if not cleaned:
        return None
    low = cleaned.lower()
    if low in BY_SLUG:
        item = BY_SLUG[low]
        return item if (category is None or item.category == category) else None

    cats = (category,) if category else _CATEGORY_PRIORITY
    # 1) Exact match (name, hyphen-free name, slug, or alias)
    for cat in cats:
        hit = _LOOKUP_BY_CAT.get(cat, {}).get(low)
        if hit is not None:
            return hit
        hit = _LOOKUP_BY_CAT.get(cat, {}).get(low.replace("-", " "))
        if hit is not None:
            return hit

    if exact_only:
        return None

    # 2) Fuzzy match against display names only (skip short tokens < 4 chars to avoid alias collisions)
    if len(low) < 4:
        return None
    candidates: list[tuple[float, IndexItem]] = []
    for cat in cats:
        for item in INDEX:
            if item.category != cat:
                continue
            target = item.name.lower()
            score = difflib.SequenceMatcher(None, low, target).ratio()
            candidates.append((score, item))
    if not candidates:
        return None
    candidates.sort(key=lambda pair: pair[0], reverse=True)
    best_score, best_item = candidates[0]
    runner_up = candidates[1][0] if len(candidates) > 1 else 0.0
    gap = best_score - runner_up
    if (best_score >= high and gap >= margin) or (best_score >= floor and gap >= strong_margin):
        return best_item
    return None


def search_index(query: str = "", *, category: str | None = None, limit: int = 25) -> list[dict[str, Any]]:
    """Instant offline search across the names-only game index."""
    q = (query or "").strip().lower()
    out: list[tuple[int, IndexItem]] = []
    for item in INDEX:
        if category and item.category != category:
            continue
        if not q:
            out.append((2, item))
            continue
        name_low = item.name.lower()
        alias_lows = [a.lower() for a in item.aliases]
        if q == name_low or q == item.slug.lower() or q in alias_lows:
            out.append((0, item))
        elif name_low.startswith(q) or any(a.startswith(q) for a in alias_lows):
            out.append((1, item))
        elif q in name_low or q in item.category:
            out.append((2, item))
    out.sort(key=lambda pair: (pair[0], pair[1].category, pair[1].name))
    return [
        {
            "slug": it.slug,
            "name": it.name,
            "category": it.category,
            "aliases": list(it.aliases),
            "slot": it.slot,
            "rarity": it.rarity,
            "wiki_page": it.wiki_page,
        }
        for _, it in out[:limit]
    ]


def master_catalog() -> dict[str, list[dict[str, Any]]]:
    """Return the full names-only master catalog of all 31 cards, 25 modules, and 9 UWs."""
    def _entry(it: IndexItem) -> dict[str, Any]:
        return {
            "slug": it.slug,
            "name": it.name,
            "category": it.category,
            "aliases": list(it.aliases),
            "slot": it.slot,
            "rarity": it.rarity,
        }

    return {
        "cards": [_entry(it) for it in INDEX if it.category == "card"],
        "modules": [_entry(it) for it in INDEX if it.category == "module"],
        "uws": [_entry(it) for it in INDEX if it.category == "uw"],
        "uw_plus": [_entry(it) for it in INDEX if it.category == "uw_plus"],
        "workshop": [_entry(it) for it in INDEX if it.category == "workshop"],
    }


catalog = master_catalog


# --- Wikitext cleaner & section extractor (text-only, zero images) -------

def clean_wikitext(raw: str) -> str:
    """Convert MediaWiki markup into readable plain text, stripping all images/files."""
    if not raw:
        return ""
    text = raw
    # Strip HTML comments, refs, and file/image embeds
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    text = re.sub(r"<ref[^>]*>.*?</ref>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<ref[^/>]*/>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\[\[(?:File|Image|Category):[^\]]*(?:\[\[[^\]]*\]\][^\]]*)*\]\]", "", text, flags=re.IGNORECASE)
    # Strip simple templates {{...}} (non-nested passes)
    for _ in range(3):
        prev = text
        text = re.sub(r"\{\{[^{}]*\}\}", "", text)
        if text == prev:
            break
    # Convert wikilinks [[Target|Label]] -> Label and [[Target]] -> Target
    text = re.sub(r"\[\[[^|\]]+\|([^\]]+)\]\]", r"\1", text)
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", text)
    # Convert external links [https://... Label] -> Label
    text = re.sub(r"\[https?://\S+\s+([^\]]+)\]", r"\1", text)
    text = re.sub(r"\[https?://\S+\]", "", text)
    # Remove bold/italic quotes and HTML tags
    text = re.sub(r"'{2,5}", "", text)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)

    # Flatten wikitable markup into readable pipe-separated rows
    lines: list[str] = []
    cur_row: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            if cur_row:
                lines.append(" | ".join(cur_row))
                cur_row = []
            lines.append("")
            continue
        if line.startswith("{|") or line.startswith("|}") or line.startswith("|+"):
            if cur_row:
                lines.append(" | ".join(cur_row))
                cur_row = []
            continue
        if line.startswith("|-"):
            if cur_row:
                lines.append(" | ".join(cur_row))
                cur_row = []
            continue
        if line.startswith("|") or line.startswith("!"):
            cell = line[1:].strip()
            parts = re.split(r"\|\||!!", cell)
            for p in parts:
                # Strip cell style prefix like 'style="..." | Value'
                if "|" in p:
                    p = p.split("|", 1)[1]
                p = " ".join(p.split())
                if p:
                    cur_row.append(p)
            continue
        if cur_row:
            lines.append(" | ".join(cur_row))
            cur_row = []
        # Normalize section headings == Heading ==
        m_hdr = re.match(r"^={2,5}\s*(.+?)\s*={2,5}$", line)
        if m_hdr:
            lines.append(f"## {m_hdr.group(1).strip()}")
        else:
            lines.append(" ".join(line.split()))
    if cur_row:
        lines.append(" | ".join(cur_row))

    # Collapse excessive blank lines
    compact: list[str] = []
    for ln in lines:
        if not ln and (not compact or not compact[-1]):
            continue
        compact.append(ln)
    return "\n".join(compact).strip()


def extract_relevant_excerpt(clean_text: str, highlight: str, *, max_chars: int = 2400) -> str:
    """Pull the section or lines matching `highlight` from a cleaned category page."""
    if not clean_text:
        return ""
    if not highlight:
        return clean_text[:max_chars]

    needle = highlight.strip().lower()
    lines = clean_text.splitlines()

    # 1) Exact section heading match (e.g. "## Scatter" or "## Tier 9")
    for idx, line in enumerate(lines):
        if line.startswith("## ") and needle in line.lower():
            chunk = [line]
            for nxt in lines[idx + 1 :]:
                if nxt.startswith("## "):
                    break
                chunk.append(nxt)
            joined = "\n".join(chunk).strip()
            if joined:
                return joined[:max_chars]

    # 2) Matching lines with surrounding context (great for wikitable rows like Galaxy Compressor / Cards)
    hits: list[str] = []
    seen_idx: set[int] = set()
    for idx, line in enumerate(lines):
        if needle in line.lower():
            start = max(0, idx - 1)
            end = min(len(lines), idx + 3)
            for j in range(start, end):
                if j not in seen_idx:
                    seen_idx.add(j)
                    hits.append(lines[j])
            if sum(len(h) for h in hits) >= max_chars:
                break
    if hits:
        return "\n".join(hits).strip()[:max_chars]

    return clean_text[:max_chars]


# --- On-demand MediaWiki API client + local JSON cache -------------------

_CACHE_LOCK = threading.RLock()


def _load_cache(cache_path: Path) -> dict[str, Any]:
    if not cache_path.is_file():
        return {"pages": {}}
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("pages"), dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {"pages": {}}


def _save_cache(cache_path: Path, data: dict[str, Any]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2)
    fd, tmp_name = tempfile.mkstemp(prefix=".wiki_cache_", suffix=".tmp", dir=str(cache_path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp_name, cache_path)
    except BaseException:
        try:
            os.remove(tmp_name)
        except OSError:
            pass
        raise


def _http_get_json(params: dict[str, str], timeout: float = 8.0) -> dict[str, Any]:
    url = f"{WIKI_API_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "TowerPilot/2.0 (local companion)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _fetch_page_raw(
    title: str,
    *,
    fetch_fn: Callable[[dict[str, str]], dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    fetcher = fetch_fn or _http_get_json
    data = fetcher(
        {
            "action": "query",
            "prop": "revisions",
            "rvprop": "content|ids",
            "rvslots": "main",
            "titles": title,
            "redirects": "1",
            "format": "json",
        }
    )
    pages = (data.get("query") or {}).get("pages") or {}
    for page in pages.values():
        if not isinstance(page, dict) or "missing" in page:
            continue
        revs = page.get("revisions") or []
        rev = revs[0] if revs else {}
        raw = ((rev.get("slots") or {}).get("main") or {}).get("*") or rev.get("*") or ""
        if raw:
            return {
                "title": str(page.get("title") or title),
                "revid": rev.get("revid"),
                "clean_text": clean_wikitext(str(raw)),
                "fetched_at": round(time.time(), 1),
            }
    return None


def _search_wiki_title(
    query: str,
    *,
    fetch_fn: Callable[[dict[str, str]], dict[str, Any]] | None = None,
) -> str | None:
    fetcher = fetch_fn or _http_get_json
    data = fetcher(
        {
            "action": "query",
            "list": "search",
            "srsearch": query,
            "srlimit": "3",
            "format": "json",
        }
    )
    hits = (data.get("query") or {}).get("search") or []
    if hits and isinstance(hits[0], dict) and hits[0].get("title"):
        return str(hits[0]["title"])
    return None


def fetch_entry(
    query_or_slug: str,
    *,
    refresh: bool = False,
    cache_path: Path = DEFAULT_WIKI_CACHE_PATH,
    fetch_fn: Callable[[dict[str, str]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Resolve a slug or free-text query to a cached or freshly fetched wiki entry."""
    raw_q = (query_or_slug or "").strip()
    if not raw_q:
        raise ValueError("query is required")

    item = BY_SLUG.get(raw_q.lower()) or match_name(raw_q)
    target_page = item.wiki_page if item is not None else raw_q
    highlight = item.highlight if item is not None else raw_q
    display_name = item.name if item is not None else raw_q
    category = item.category if item is not None else "wiki"
    slug = item.slug if item is not None else f"wiki:{_slugify(raw_q)}"

    with _CACHE_LOCK:
        cache = _load_cache(cache_path)
        cached_page = cache["pages"].get(target_page.lower())

    page_data: dict[str, Any] | None = None
    from_cache = False
    error: str | None = None

    if cached_page and not refresh:
        page_data = cached_page
        from_cache = True
    else:
        try:
            page_data = _fetch_page_raw(target_page, fetch_fn=fetch_fn)
            if page_data is None and item is not None and item.category == "uw":
                # Fallback to Ultimate Weapons overview if individual UW page moved
                page_data = _fetch_page_raw("Ultimate Weapons", fetch_fn=fetch_fn)
            if page_data is None:
                alt = _search_wiki_title(display_name, fetch_fn=fetch_fn)
                if alt:
                    page_data = _fetch_page_raw(alt, fetch_fn=fetch_fn)
            if page_data is not None:
                with _CACHE_LOCK:
                    cache = _load_cache(cache_path)
                    cache["pages"][target_page.lower()] = page_data
                    cache["pages"][page_data["title"].lower()] = page_data
                    _save_cache(cache_path, cache)
        except Exception as exc:
            error = f"Wiki fetch failed: {exc}"
            if cached_page:
                page_data = cached_page
                from_cache = True

    if page_data is None:
        return {
            "slug": slug,
            "name": display_name,
            "category": category,
            "aliases": list(item.aliases) if item else [],
            "page_title": target_page,
            "url": WIKI_PAGE_BASE + urllib.parse.quote(target_page.replace(" ", "_")),
            "revid": None,
            "fetched_at": None,
            "cached": False,
            "excerpt": "",
            "error": error or f"No wiki page found for '{display_name}'.",
        }

    title = page_data["title"]
    # Dedicated page (e.g. "Golden Tower") -> show the page from the top rather than jumping to a sub-heading
    effective_highlight = "" if title.strip().lower() == highlight.strip().lower() else highlight
    excerpt = extract_relevant_excerpt(page_data.get("clean_text", ""), effective_highlight)
    return {
        "slug": slug,
        "name": display_name,
        "category": category,
        "aliases": list(item.aliases) if item else [],
        "page_title": title,
        "url": WIKI_PAGE_BASE + urllib.parse.quote(title.replace(" ", "_")),
        "revid": page_data.get("revid"),
        "fetched_at": page_data.get("fetched_at"),
        "cached": from_cache,
        "excerpt": excerpt,
        "error": error,
    }
