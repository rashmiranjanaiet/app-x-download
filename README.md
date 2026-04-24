# DX Downloader

DX Downloader is now structured as an Android-first project:

- `mobile/` contains a Flutter app for the APK UI
- `server/` contains the Node.js download API powered by `yt-dlp` and `ffmpeg`
- `client/` is the earlier React web client kept only as a reference during the transition

The mobile app does not do the heavy video processing itself. It calls the backend API, and the backend handles metadata lookup, MP4 preparation, and MP3 conversion.

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
Copy-Item android\local.properties.example android\local.properties
flutter pub get
flutter run --dart-define=DX_API_BASE_URL=http://10.0.2.2:3001
```

For a real Android device, replace `10.0.2.2` with your computer's LAN IP address, for example:

```bash
flutter run --dart-define=DX_API_BASE_URL=http://192.168.1.10:3001
```

## Build the APK

From `mobile/`:

```bash
flutter build apk --release --dart-define=DX_API_BASE_URL=http://10.0.2.2:3001
```

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
- The Android app needs a reachable backend URL. `localhost` inside an emulator or device is not your computer.
