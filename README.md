# Martin Social Hub — Personal SocialBee-Style Studio & Cloud Auto-Poster

A free, self-hosted social media scheduler running 100% on **GitHub Pages** (interactive dashboard + public Instagram media hosting) and **GitHub Actions** (automated randomized cloud publishing even when your computer is off).

## Features
- **Interactive Web Studio (`index.html`):** Review & validate new posts, edit text inline, schedule exact dates or auto-randomized queue, upload new images directly to `media/`, reload/import fresh queues, copy-paste manual X/Group posts, and view live posted history.
- **Instagram-Ready Media Hosting:** All images in `media/` are pre-optimized JPEGs (Instagram-safe aspect ratios and `< 1 MB`), served directly over HTTPS so Instagram Graph API publishes automatically.
- **Zero Secrets in Repo:** API keys live strictly in encrypted **GitHub Repository Secrets**. Your GitHub Personal Access Token for saving edits from the web UI lives strictly in your browser's `localStorage`.

---

## One-Time GitHub Setup (~5 Minutes)

### 1. Create a Public Repo on GitHub
1. Go to **https://github.com/new**
2. Repository name: **`social-hub`**
3. Visibility: **Public** *(required for free GitHub Pages & for Meta's Instagram API to fetch your `media/` images over HTTPS — zero secrets are in this repo!)*.
4. Click **Create repository** (leave it empty — no README/gitignore).

### 2. Push This Folder to GitHub
Run these commands in PowerShell inside `C:\Users\RepairTest\Documents\Martin\social-hub`:
```powershell
git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/social-hub.git
git push -u origin main
```

### 3. Enable GitHub Pages (Your Live Web Studio URL)
1. Open your repo on GitHub → **Settings** → **Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch** → branch **`main`**, folder **`/ (root)`** → **Save**.
3. Your live dashboard will appear in ~1 minute at:
   `https://<YOUR_GITHUB_USERNAME>.github.io/social-hub/`

### 4. Add Your API Secrets (Encrypted in GitHub Actions)
Open your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, and copy these 6 values from your local `social media\scripts\.env`:
- `LINKEDIN_ACCESS_TOKEN`
- `LINKEDIN_PERSON_URN`
- `FB_PAGE_ID`
- `FB_PAGE_ACCESS_TOKEN`
- `IG_USER_ID`
- `IG_ACCESS_TOKEN`

*(Optional later: `IG_LITTLESOULS_USER_ID`, `IG_LITTLESOULS_ACCESS_TOKEN`, `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`.)*

### 5. Connect the Web Studio (One-Time)
1. Create a **Fine-Grained Personal Access Token** at **https://github.com/settings/personal-access-tokens/new**:
   - **Repository access:** Only select repositories → **`social-hub`**
   - **Repository permissions:** **Contents → Read and write**, **Actions → Read and write**
   - Click **Generate token** and copy it.
2. Open your live dashboard (`https://<YOUR_GITHUB_USERNAME>.github.io/social-hub/`), click **⚙ Settings**, paste the token, and click **Apply Settings**.

You're live! Click **⚡ Run Now** → **Instagram** to test your very first automated Instagram post right from the cloud!
