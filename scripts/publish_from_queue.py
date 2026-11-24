"""
Cloud Social Auto-Poster for GitHub Actions (and local runs).
Reads data/queue.json + data/config.json, publishes eligible approved posts via official APIs
(LinkedIn, Facebook Page, Instagram Professional, and optional X), and updates data/queue.json + data/post_log.json.
"""
import argparse
import json
import mimetypes
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import quote

import requests

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT_DIR, 'data')
QUEUE_PATH = os.path.join(DATA_DIR, 'queue.json')
CONFIG_PATH = os.path.join(DATA_DIR, 'config.json')
LOG_PATH = os.path.join(DATA_DIR, 'post_log.json')

PLATFORMS = ['LinkedIn', 'Facebook', 'Instagram', 'X']


def load_json(path: str, default):
    if not os.path.isfile(path):
        return default
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_json(path: str, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)


def parse_iso_utc(s: str):
    if not s:
        return None
    s = s.strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def hours_since_last_post(post_log: list, platform: str) -> float:
    last_dt = None
    for ev in post_log:
        if ev.get('platform') == platform and ev.get('status') == 'POSTED':
            dt = parse_iso_utc(ev.get('ts', ''))
            if dt and (last_dt is None or dt > last_dt):
                last_dt = dt
    if not last_dt:
        return 9999.0
    return (datetime.now(timezone.utc) - last_dt).total_seconds() / 3600.0


def has_credentials(platform: str) -> bool:
    if platform == 'LinkedIn':
        return bool(os.getenv('LINKEDIN_ACCESS_TOKEN'))
    if platform == 'Facebook':
        return all(os.getenv(k) for k in ('FB_PAGE_ID', 'FB_PAGE_ACCESS_TOKEN'))
    if platform == 'Instagram':
        return all(os.getenv(k) for k in ('IG_USER_ID', 'IG_ACCESS_TOKEN'))
    if platform == 'X':
        return all(os.getenv(k) for k in ('X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'))
    return False


def resolve_local_media(rel_path: str) -> str:
    if not rel_path or rel_path.startswith('http'):
        return ''
    full = os.path.normpath(os.path.join(ROOT_DIR, rel_path))
    return full if os.path.isfile(full) else ''


def resolve_public_media_url(rel_path: str, config: dict) -> str:
    if not rel_path:
        return ''
    if rel_path.startswith('http://') or rel_path.startswith('https://'):
        return rel_path

    clean_rel = rel_path.lstrip('/').replace('\\', '/')
    encoded_rel = '/'.join(quote(part) for part in clean_rel.split('/'))

    base = (os.getenv('IG_MEDIA_BASE_URL') or config.get('media_base_url') or '').strip().rstrip('/')
    if base:
        # Avoid double /media/media/ if user entered base ending in /media
        if base.endswith('/media') and encoded_rel.startswith('media/'):
            encoded_rel = encoded_rel[len('media/'):]
        return f'{base}/{encoded_rel}'

    gh_repo = (os.getenv('GITHUB_REPOSITORY') or '').strip()
    gh_ref = (os.getenv('GITHUB_REF_NAME') or 'main').strip()
    if gh_repo and '/' in gh_repo:
        # raw.githubusercontent.com serves direct JPEG/MP4 with zero Pages propagation delay
        return f'https://raw.githubusercontent.com/{gh_repo}/{gh_ref}/{encoded_rel}'

    raise RuntimeError(
        'Cannot determine public HTTPS media URL for Instagram. '
        'Run inside GitHub Actions or set media_base_url in data/config.json.'
    )


# ---------------- LinkedIn (Auto-Versioned REST API) ---------------- #

def _linkedin_version_candidates(preferred_ver: str = None) -> list:
    cands = []
    if preferred_ver:
        cands.append(preferred_ver)
    env_ver = (os.getenv('LINKEDIN_API_VERSION') or '').strip()
    if env_ver and env_ver not in cands:
        cands.append(env_ver)
    now = datetime.now(timezone.utc)
    y, m = now.year, now.month
    for _ in range(14):
        ver = f'{y:04d}{m:02d}'
        if ver not in cands:
            cands.append(ver)
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    return cands


def _linkedin_rest_post(url: str, token: str, payload: dict, preferred_ver: str = None):
    last_resp, last_ver = None, None
    for ver in _linkedin_version_candidates(preferred_ver):
        headers = {
            'Authorization': f'Bearer {token}',
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': ver,
            'Content-Type': 'application/json',
        }
        resp = requests.post(url, headers=headers, json=payload, timeout=30)
        last_resp, last_ver = resp, ver
        if resp.status_code == 426 and 'NONEXISTENT_VERSION' in resp.text:
            continue
        return resp, ver
    return last_resp, last_ver


def publish_linkedin(post: dict, config: dict) -> str:
    token = os.getenv('LINKEDIN_ACCESS_TOKEN')
    person_urn = os.getenv('LINKEDIN_PERSON_URN')
    if not token:
        raise RuntimeError('Missing LINKEDIN_ACCESS_TOKEN secret.')
    if not person_urn:
        r = requests.get('https://api.linkedin.com/v2/userinfo', headers={'Authorization': f'Bearer {token}'}, timeout=15)
        if r.status_code == 200 and r.json().get('sub'):
            person_urn = f"urn:li:person:{r.json()['sub']}"
        else:
            raise RuntimeError('Missing LINKEDIN_PERSON_URN secret (and /v2/userinfo lookup failed).')

    payload = {
        'author': person_urn,
        'commentary': post['text'],
        'visibility': 'PUBLIC',
        'distribution': {
            'feedDistribution': 'MAIN_FEED',
            'targetEntities': [],
            'thirdPartyDistributionChannels': [],
        },
        'lifecycleState': 'PUBLISHED',
        'isReshareDisabledByAuthor': False,
    }

    working_ver = None
    media_file = resolve_local_media(post.get('media', ''))
    if media_file and os.path.splitext(media_file)[1].lower() in ('.jpg', '.jpeg', '.png'):
        init_resp, working_ver = _linkedin_rest_post(
            'https://api.linkedin.com/rest/images?action=initializeUpload',
            token,
            {'initializeUploadRequest': {'owner': person_urn}},
        )
        if init_resp.status_code not in (200, 201):
            raise RuntimeError(f'LinkedIn image init error {init_resp.status_code}: {init_resp.text}')
        val = init_resp.json()['value']
        ctype = mimetypes.guess_type(media_file)[0] or 'image/jpeg'
        with open(media_file, 'rb') as f:
            up = requests.put(
                val['uploadUrl'],
                headers={'Authorization': f'Bearer {token}', 'Content-Type': ctype},
                data=f.read(),
                timeout=60,
            )
        if up.status_code not in (200, 201):
            raise RuntimeError(f'LinkedIn image upload error {up.status_code}: {up.text}')
        payload['content'] = {'media': {'id': val['image'], 'title': post.get('project', 'Attachment')[:100]}}

    resp, _ = _linkedin_rest_post('https://api.linkedin.com/rest/posts', token, payload, preferred_ver=working_ver)
    if resp.status_code not in (200, 201):
        raise RuntimeError(f'LinkedIn API error {resp.status_code}: {resp.text}')
    post_id = resp.headers.get('x-restli-id', 'published')
    return f'https://www.linkedin.com/feed/update/{post_id}/'


# ---------------- Facebook Author Page ---------------- #

def publish_facebook(post: dict, config: dict) -> str:
    page_id = os.getenv('FB_PAGE_ID')
    page_token = os.getenv('FB_PAGE_ACCESS_TOKEN')
    if not (page_id and page_token):
        raise RuntimeError('Missing FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN secrets.')

    ver = os.getenv('META_GRAPH_VERSION', 'v21.0')
    media_file = resolve_local_media(post.get('media', ''))
    ext = os.path.splitext(media_file)[1].lower() if media_file else ''

    if media_file and ext in ('.jpg', '.jpeg', '.png'):
        url = f'https://graph.facebook.com/{ver}/{page_id}/photos'
        with open(media_file, 'rb') as f:
            resp = requests.post(
                url,
                data={'caption': post['text'], 'access_token': page_token},
                files={'source': f},
                timeout=60,
            )
    elif media_file and ext == '.mp4':
        url = f'https://graph.facebook.com/{ver}/{page_id}/videos'
        with open(media_file, 'rb') as f:
            resp = requests.post(
                url,
                data={'description': post['text'], 'access_token': page_token},
                files={'source': f},
                timeout=180,
            )
    else:
        url = f'https://graph.facebook.com/{ver}/{page_id}/feed'
        data = {'message': post['text'], 'access_token': page_token}
        link = (post.get('link') or '').strip()
        if link.startswith('http'):
            data['link'] = link
        resp = requests.post(url, data=data, timeout=30)

    if resp.status_code != 200:
        raise RuntimeError(f'Facebook Graph API error {resp.status_code}: {resp.text}')
    post_id = resp.json().get('post_id') or resp.json().get('id')
    return f'https://www.facebook.com/{post_id}'


# ---------------- Instagram Professional ---------------- #

def publish_instagram(post: dict, config: dict) -> str:
    account = (post.get('account') or '').lower()
    if 'littlesouls' in account and os.getenv('IG_LITTLESOULS_USER_ID'):
        ig_user_id = os.getenv('IG_LITTLESOULS_USER_ID')
        ig_token = os.getenv('IG_LITTLESOULS_ACCESS_TOKEN') or os.getenv('IG_ACCESS_TOKEN')
    else:
        ig_user_id = os.getenv('IG_USER_ID')
        ig_token = os.getenv('IG_ACCESS_TOKEN')

    if not (ig_user_id and ig_token):
        raise RuntimeError('Missing IG_USER_ID or IG_ACCESS_TOKEN secrets.')

    media_url = resolve_public_media_url(post.get('media', ''), config)
    if not media_url:
        raise RuntimeError('Instagram posts require an image or video.')

    ver = os.getenv('META_GRAPH_VERSION', 'v21.0')
    is_video = media_url.lower().endswith('.mp4')
    create_url = f'https://graph.facebook.com/{ver}/{ig_user_id}/media'
    payload = {'caption': post['text'], 'access_token': ig_token}
    if is_video:
        payload['media_type'] = 'REELS'
        payload['video_url'] = media_url
    else:
        payload['image_url'] = media_url

    r1 = requests.post(create_url, data=payload, timeout=30)
    if r1.status_code != 200:
        raise RuntimeError(f'IG container creation error {r1.status_code}: {r1.text}')
    creation_id = r1.json()['id']

    # Poll until container processing finishes (especially important for videos & larger JPEGs)
    status_url = f'https://graph.facebook.com/{ver}/{creation_id}'
    for _ in range(15):
        time.sleep(6 if is_video else 2)
        st_r = requests.get(status_url, params={'fields': 'status_code,status', 'access_token': ig_token}, timeout=20)
        if st_r.status_code == 200:
            code = (st_r.json().get('status_code') or '').upper()
            if code in ('FINISHED', 'PUBLISHED'):
                break
            if code == 'ERROR':
                raise RuntimeError(f'IG media container failed processing: {st_r.text}')

    pub_url = f'https://graph.facebook.com/{ver}/{ig_user_id}/media_publish'
    r2 = requests.post(pub_url, data={'creation_id': creation_id, 'access_token': ig_token}, timeout=30)
    if r2.status_code != 200:
        raise RuntimeError(f'IG publish error {r2.status_code}: {r2.text}')
    media_id = r2.json()['id']
    return f'https://www.instagram.com/p/{media_id}/'


# ---------------- X (Optional) ---------------- #

def publish_x(post: dict, config: dict) -> str:
    import tweepy
    ak, aks = os.getenv('X_API_KEY'), os.getenv('X_API_SECRET')
    at, ats = os.getenv('X_ACCESS_TOKEN'), os.getenv('X_ACCESS_TOKEN_SECRET')
    if not all([ak, aks, at, ats]):
        raise RuntimeError('Missing X API secrets.')

    client = tweepy.Client(consumer_key=ak, consumer_secret=aks, access_token=at, access_token_secret=ats)
    media_ids = None
    media_file = resolve_local_media(post.get('media', ''))
    if media_file:
        auth = tweepy.OAuth1UserHandler(ak, aks, at, ats)
        api_v1 = tweepy.API(auth)
        ext = os.path.splitext(media_file)[1].lower()
        if ext in ('.jpg', '.jpeg', '.png', '.gif', '.webp'):
            media_ids = [api_v1.media_upload(filename=media_file).media_id]
        elif ext == '.mp4':
            media_ids = [api_v1.media_upload(filename=media_file, chunked=True, media_category='tweet_video').media_id]

    kwargs = {'text': post['text']}
    if media_ids:
        kwargs['media_ids'] = media_ids
    m = re.search(r'/status/(\d+)', post.get('target_url', '') or '')
    if m:
        kwargs['in_reply_to_tweet_id'] = m.group(1)

    resp = client.create_tweet(**kwargs)
    return f"https://x.com/i/web/status/{resp.data['id']}"


PUBLISHERS = {
    'LinkedIn': publish_linkedin,
    'Facebook': publish_facebook,
    'Instagram': publish_instagram,
    'X': publish_x,
}


# ---------------- Main Runner ---------------- #

def main():
    parser = argparse.ArgumentParser(description='Martin Social Hub Cloud Auto-Poster')
    parser.add_argument('--dry-run', action='store_true', help='Preview without calling live APIs')
    parser.add_argument('--platform', default='all', help='Limit to one platform (LinkedIn/Facebook/Instagram/X/all)')
    parser.add_argument('--max-posts', type=int, default=0, help='Override config max_posts_per_run')
    parser.add_argument('--no-jitter', action='store_true', help='Skip randomized startup sleep')
    parser.add_argument('--ignore-pacing', action='store_true', help='Ignore min_hours_per_platform (for manual testing)')
    args = parser.parse_args()

    queue_data = load_json(QUEUE_PATH, {'version': 1, 'posts': []})
    posts = queue_data.get('posts', [])
    config = load_json(CONFIG_PATH, {})
    post_log = load_json(LOG_PATH, [])

    enabled = config.get('enabled_platforms', {'LinkedIn': True, 'Facebook': True, 'Instagram': True, 'X': False})
    max_posts = args.max_posts if args.max_posts > 0 else int(config.get('max_posts_per_run', 2))
    min_hours = 0.0 if args.ignore_pacing else float(config.get('min_hours_per_platform', 36))
    do_shuffle = bool(config.get('shuffle', True))
    jitter_max = int(config.get('random_jitter_max_minutes', 35))

    if args.platform != 'all':
        target_platforms = [args.platform]
    else:
        target_platforms = [p for p in PLATFORMS if enabled.get(p, False)]

    now_utc = datetime.now(timezone.utc)
    print(f'[{now_utc.isoformat()}] Social Hub Runner | Dry-Run={args.dry_run} | Platforms={target_platforms} | Max={max_posts}')

    # Collect eligible posts
    due_scheduled = []
    auto_pool = []

    for idx, p in enumerate(posts):
        plat = p.get('platform')
        if plat not in target_platforms:
            continue
        if not p.get('approved'):
            continue
        if (p.get('status') or 'PENDING').upper() != 'PENDING':
            continue
        if (p.get('automation_mode') or 'API_AUTO').upper() != 'API_AUTO':
            continue
        if not args.dry_run and not has_credentials(plat):
            continue

        sched_dt = parse_iso_utc(p.get('scheduled_at', ''))
        if sched_dt:
            if sched_dt <= now_utc:
                due_scheduled.append((idx, p))
            continue

        # Auto-queue post: check platform pacing
        if min_hours > 0:
            hrs = hours_since_last_post(post_log, plat)
            if hrs < min_hours:
                continue
        auto_pool.append((idx, p))

    if do_shuffle:
        random.shuffle(auto_pool)

    # Pick scheduled due posts first, then up to 1 auto-queue post per platform until max_posts
    to_publish = []
    seen_auto_plats = set()
    for item in due_scheduled:
        to_publish.append(item)
        seen_auto_plats.add(item[1]['platform'])

    for item in auto_pool:
        if len(to_publish) >= max_posts:
            break
        plat = item[1]['platform']
        if min_hours > 0 and plat in seen_auto_plats:
            continue
        to_publish.append(item)
        seen_auto_plats.add(plat)

    if not to_publish:
        print('No eligible posts to publish in this run (either paced, scheduled in future, or queue complete).')
        return

    # Optional random jitter on scheduled GitHub Actions runs so posts don't always land on :00
    is_scheduled_event = os.getenv('GITHUB_EVENT_NAME') == 'schedule'
    if is_scheduled_event and not args.dry_run and not args.no_jitter and jitter_max > 0:
        wait_sec = random.randint(0, jitter_max * 60)
        print(f'Scheduled run: applying natural random delay of {wait_sec // 60}m {wait_sec % 60}s...')
        time.sleep(wait_sec)

    changed = False
    for idx, p in to_publish:
        plat = p['platform']
        pid = p['id']
        print(f"\n-> Processing [{plat}] {pid}: {p.get('project', '')}")
        print(f"   Media: {p.get('media') or '(none)'}")
        if args.dry_run:
            if plat == 'Instagram' and p.get('media'):
                try:
                    print(f"   IG Public URL: {resolve_public_media_url(p['media'], config)}")
                except Exception as e:
                    print(f"   IG Public URL note: {e}")
            print('   [DRY-RUN] Would publish.')
            continue

        try:
            live_url = PUBLISHERS[plat](p, config)
            ts = datetime.now(timezone.utc).isoformat()
            posts[idx]['status'] = 'POSTED'
            posts[idx]['posted_at'] = ts
            posts[idx]['live_url'] = live_url
            post_log.append({
                'ts': ts,
                'platform': plat,
                'id': pid,
                'project': p.get('project', ''),
                'status': 'POSTED',
                'url': live_url,
            })
            changed = True
            print(f'   [POSTED] {live_url}')
        except Exception as e:
            post_log.append({
                'ts': datetime.now(timezone.utc).isoformat(),
                'platform': plat,
                'id': pid,
                'project': p.get('project', ''),
                'status': 'ERROR',
                'error': str(e),
            })
            changed = True
            print(f'   [ERROR] {e}', file=sys.stderr)

    if changed:
        save_json(QUEUE_PATH, queue_data)
        save_json(LOG_PATH, post_log[-250:])
        print('\nUpdated data/queue.json and data/post_log.json.')


if __name__ == '__main__':
    main()
