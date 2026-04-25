# DX Downloader

DX Downloader is now structured as an Android-first project:

- `mobile/` contains a Flutter app for the APK UI
- `server/` contains the Node.js download API powered by `yt-dlp` and `ffmpeg`
- `client/` is the earlier React web client kept only as a reference during the transition

The mobile app does not do the heavy video processing itself. It calls the backend API, and the backend handles metadata lookup, MP4 preparation, and MP3 conversion.

For public APK distribution, the app can now auto-load one shared backend URL from `mobile/backend-config.json` in this repository. That means you can deploy the backend once, update the config file once, and all users can use the same public server.

## Current architecture

- Flutter mobile app for Android
- Express backend API
- `yt-dlp` for metadata extraction and media downloads
- `ffmpeg` for conversion workflows
- Optional Docker backend packaging

## Backend setup

### 1. Install Node dependencies

```bash
npm install
```

### 2. Download the local `yt-dlp` binary

```bash
npm run setup:tools
```

This downloads `yt-dlp` into `server/bin` for local development.

### 3. Start the backend API

```bash
npm run dev
```

The API runs on `http://localhost:3001`.

Useful endpoints:

- `GET /`
- `GET /api/health`
- `POST /api/info`
- `GET /api/download`

### 4. Optional binary overrides

`ffmpeg-static` is bundled through npm, so you usually do not need to install FFmpeg manually.

If you prefer custom paths:

```bash
YTDLP_PATH=yt-dlp
FFMPEG_PATH=ffmpeg
```

## Flutter app setup

The Flutter project lives in `mobile/`.

Typical local steps:

```bash
cd mobile
flutter pub get
flutter run --dart-define=DX_API_BASE_URL=http://10.0.2.2:3001
```

For a real Android device, replace `10.0.2.2` with your computer's LAN IP address, for example:

```bash
flutter run --dart-define=DX_API_BASE_URL=http://192.168.1.10:3001
```

For a hosted backend, use its public HTTPS URL instead:

```bash
flutter run --dart-define=DX_API_BASE_URL=https://your-backend.example.com
```

## Public deployment for everyone

This repo now includes [render.yaml](./render.yaml) for deploying the backend to Render and [mobile/backend-config.json](./mobile/backend-config.json) for publishing one shared public backend URL to all APK installs.

### Deploy the backend on Render

1. Push this repo to GitHub.
2. In Render, create a new Blueprint from this repo.
3. Render will create the Docker web service defined in `render.yaml`.
4. After the deploy finishes, your backend should be reachable at `https://app-x-download-api.onrender.com` if Render keeps the service name from `render.yaml`.

### Publish the shared backend URL

Update `mobile/backend-config.json` like this and push it to GitHub:

```json
{
  "apiBaseUrl": "https://app-x-download-api.onrender.com"
}
```

After that, release APKs built from this repo can auto-load the shared public backend URL from GitHub, so every user can use the same server without being on your Wi-Fi. If Render assigns a different hostname, update `mobile/backend-config.json` to match it and push again.

## Build the APK

From `mobile/`:

If you are using the shared public backend config, build normally:

```bash
flutter build apk --release
```

If you want to hardcode a backend directly into the APK instead, use one of these:

```bash
flutter build apk --release --dart-define=DX_API_BASE_URL=https://your-backend.example.com
```

```bash
flutter build apk --release --dart-define=DX_API_BASE_URL=http://192.168.1.10:3001
```

Do not build a public APK with `10.0.2.2`. That address only works inside the Android emulator.

The APK output path will be:

```text
mobile/build/app/outputs/flutter-apk/app-release.apk
```

## Docker backend

If you want to run only the backend in a container:

```bash
docker build -t dx-backend .
docker run -p 3001:10000 dx-backend
```

## Important notes

- Only process content you own or have permission to download.
- Public Instagram and YouTube links work best. Private, age-restricted, or region-locked content may fail.
- The Android app needs a reachable backend URL.
- For public use by everyone, deploy the backend to a public host such as Render and publish that URL in `mobile/backend-config.json`.
- `10.0.2.2` only works inside the Android emulator.
- On a real phone, use a public HTTPS backend or your computer's LAN IP while both devices are on the same Wi-Fi.
