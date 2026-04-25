import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

const defaultApiBaseUrl = String.fromEnvironment(
  'DX_API_BASE_URL',
  defaultValue: kReleaseMode ? '' : 'http://10.0.2.2:3001',
);
const defaultBackendConfigUrl = String.fromEnvironment(
  'DX_BACKEND_CONFIG_URL',
  defaultValue:
      'https://raw.githubusercontent.com/rashmiranjanaiet/app-x-download/main/mobile/backend-config.json',
);

void main() => runApp(const DxApp());

class DxApp extends StatelessWidget {
  const DxApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'DX Downloader',
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFFFF5B66),
          secondary: Color(0xFFFF8F42),
          surface: Color(0xFF171421),
        ),
        scaffoldBackgroundColor: const Color(0xFF0B0812),
      ),
      home: const DxHomePage(),
    );
  }
}

class DxHomePage extends StatefulWidget {
  const DxHomePage({super.key});

  @override
  State<DxHomePage> createState() => _DxHomePageState();
}

class _DxHomePageState extends State<DxHomePage> {
  static const storageKey = 'dx_api_base_url';

  final dio = Dio(
    BaseOptions(
      connectTimeout: const Duration(seconds: 30),
      receiveTimeout: const Duration(minutes: 10),
      sendTimeout: const Duration(seconds: 30),
    ),
  );

  final apiController = TextEditingController();
  final linkController = TextEditingController();

  DxMediaDetails? details;
  File? latestDownload;
  bool loading = true;
  bool analyzing = false;
  String downloadingKey = '';
  String error = '';
  String sharedApiBaseUrl = '';
  DownloadMode activeMode = DownloadMode.video;

  @override
  void initState() {
    super.initState();
    _restoreApiBaseUrl();
  }

  @override
  void dispose() {
    apiController.dispose();
    linkController.dispose();
    super.dispose();
  }

  Future<void> _restoreApiBaseUrl() async {
    final prefs = await SharedPreferences.getInstance();
    final storedBaseUrl = (prefs.getString(storageKey) ?? '').trim();
    final resolvedSharedBaseUrl = await _resolveSharedApiBaseUrl();
    final useStoredBaseUrl =
        storedBaseUrl.isNotEmpty &&
        !(kReleaseMode &&
            resolvedSharedBaseUrl.isNotEmpty &&
            _isLocalBaseUrl(storedBaseUrl));
    final initialBaseUrl = useStoredBaseUrl
        ? storedBaseUrl
        : resolvedSharedBaseUrl;

    if (!useStoredBaseUrl && storedBaseUrl.isNotEmpty) {
      await prefs.remove(storageKey);
    }

    apiController.text = initialBaseUrl;
    if (mounted) {
      setState(() {
        sharedApiBaseUrl = resolvedSharedBaseUrl;
        loading = false;
        if (kReleaseMode && initialBaseUrl.isEmpty && error.isEmpty) {
          error =
              'DX is not configured with a public server yet. Deploy the backend and update mobile/backend-config.json, or enter a working backend URL below.';
        }
      });
    }
  }

  Future<void> _saveApiBaseUrl(String value) async {
    final prefs = await SharedPreferences.getInstance();
    final normalizedValue = _normalizeBaseUrl(value);
    final normalizedSharedBaseUrl = _normalizedSharedApiBaseUrl;

    if (normalizedSharedBaseUrl.isNotEmpty &&
        _sameBaseUrl(normalizedValue, normalizedSharedBaseUrl)) {
      await prefs.remove(storageKey);
      return;
    }

    await prefs.setString(storageKey, normalizedValue);
  }

  Future<String> _resolveSharedApiBaseUrl() async {
    if (defaultApiBaseUrl.trim().isNotEmpty) {
      return _normalizeBaseUrl(defaultApiBaseUrl);
    }

    return _fetchRemoteSharedApiBaseUrl();
  }

  Future<String> _fetchRemoteSharedApiBaseUrl() async {
    try {
      final response = await dio.getUri<Map<String, dynamic>>(
        Uri.parse(defaultBackendConfigUrl),
        options: Options(
          sendTimeout: const Duration(seconds: 20),
          receiveTimeout: const Duration(seconds: 20),
        ),
      );
      final payload = response.data;
      if (payload == null) {
        return '';
      }

      final value = payload['apiBaseUrl'];
      if (value is! String || value.trim().isEmpty) {
        return '';
      }

      return _normalizeBaseUrl(value);
    } catch (_) {
      return '';
    }
  }

  Future<void> _useSharedServer() async {
    final normalizedSharedBaseUrl = _normalizedSharedApiBaseUrl;
    if (normalizedSharedBaseUrl.isEmpty) {
      return;
    }

    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(storageKey);

    if (!mounted) {
      return;
    }

    setState(() {
      apiController.text = normalizedSharedBaseUrl;
      error = '';
    });
  }

  Future<void> _analyze() async {
    final url = linkController.text.trim();
    if (url.isEmpty) {
      setState(() => error = 'Paste a YouTube or Instagram link.');
      return;
    }

    setState(() {
      analyzing = true;
      error = '';
      details = null;
      latestDownload = null;
      activeMode = DownloadMode.video;
    });

    try {
      final baseUrl = _normalizeBaseUrl(apiController.text);
      await _saveApiBaseUrl(baseUrl);
      final response = await dio.postUri<Map<String, dynamic>>(
        _apiUri(baseUrl, '/api/info'),
        data: {'url': url},
      );
      final payload = response.data;
      if (payload == null) {
        throw const DxException('No media details were returned.');
      }
      if (!mounted) return;
      setState(() => details = DxMediaDetails.fromJson(payload));
    } catch (err) {
      if (!mounted) return;
      setState(() => error = _friendlyError(err));
    } finally {
      if (mounted) {
        setState(() => analyzing = false);
      }
    }
  }

  Future<void> _download({
    required DownloadMode mode,
    String? quality,
    required String key,
  }) async {
    final current = details;
    if (current == null) return;

    setState(() {
      downloadingKey = key;
      error = '';
    });

    try {
      final baseUrl = _normalizeBaseUrl(apiController.text);
      await _saveApiBaseUrl(baseUrl);
      final query = {
        'url': current.url,
        'mode': mode.value,
        if (quality != null) 'quality': quality,
      };
      final response = await dio.getUri<ResponseBody>(
        _apiUri(baseUrl, '/api/download', query),
        options: Options(responseType: ResponseType.stream),
      );
      final body = response.data;
      if (body == null) {
        throw const DxException(
          'Download failed before any file data was returned.',
        );
      }

      final fileName = _fileNameFromHeaders(
        response.headers.value('content-disposition'),
        current.title,
        mode,
      );
      final file = await _nextDownloadFile(fileName);
      final sink = file.openWrite();
      await sink.addStream(body.stream);
      await sink.close();

      if (!mounted) return;
      setState(() => latestDownload = file);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Saved ${file.path.split(Platform.pathSeparator).last}',
          ),
        ),
      );
    } catch (err) {
      if (!mounted) return;
      setState(() => error = _friendlyError(err));
    } finally {
      if (mounted) {
        setState(() => downloadingKey = '');
      }
    }
  }

  Future<File> _nextDownloadFile(String fileName) async {
    final docs = await getApplicationDocumentsDirectory();
    final dir = Directory('${docs.path}${Platform.pathSeparator}downloads');
    if (!await dir.exists()) await dir.create(recursive: true);
    final dot = fileName.lastIndexOf('.');
    final base = dot > 0 ? fileName.substring(0, dot) : fileName;
    final ext = dot > 0 ? fileName.substring(dot) : '';
    var file = File('${dir.path}${Platform.pathSeparator}$fileName');
    var suffix = 1;
    while (await file.exists()) {
      file = File('${dir.path}${Platform.pathSeparator}$base-$suffix$ext');
      suffix += 1;
    }
    return file;
  }

  Future<void> _openLatestDownload() async {
    final file = latestDownload;
    if (file == null) return;
    final result = await OpenFilex.open(file.path);
    if (!mounted || result.type == ResultType.done) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          result.message.isEmpty ? 'Could not open the file.' : result.message,
        ),
      ),
    );
  }

  Future<void> _copyLatestPath() async {
    final file = latestDownload;
    if (file == null) return;
    await Clipboard.setData(ClipboardData(text: file.path));
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('Download path copied.')));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Color(0xFF120E1C), Color(0xFF0A0812), Color(0xFF19121D)],
          ),
        ),
        child: SafeArea(
          child: loading
              ? const Center(child: CircularProgressIndicator())
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    _panel(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'DX Downloader',
                            style: TextStyle(
                              fontSize: 28,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            Platform.isAndroid
                                ? (kReleaseMode
                                      ? 'This APK can use one shared public DX server for everyone after the backend is deployed. You can still override the backend URL below.'
                                      : 'Flutter Android app. Use 10.0.2.2 for the emulator or your computer LAN IP for a real device.')
                                : 'Flutter mobile app for the DX backend API.',
                            style: const TextStyle(color: Color(0xFFC8BFD8)),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                    _panel(
                      child: Column(
                        children: [
                          TextField(
                            controller: apiController,
                            decoration: _input(
                              'Backend URL',
                              kReleaseMode
                                  ? 'Shared public backend will appear here'
                                  : 'http://10.0.2.2:3001',
                            ),
                          ),
                          if (kReleaseMode && sharedApiBaseUrl.isNotEmpty) ...[
                            const SizedBox(height: 8),
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    _sameBaseUrl(
                                          apiController.text,
                                          sharedApiBaseUrl,
                                        )
                                        ? 'Using the shared DX public server.'
                                        : 'A shared DX public server is available for all users.',
                                    style: const TextStyle(
                                      color: Color(0xFFC8BFD8),
                                    ),
                                  ),
                                ),
                                if (!_sameBaseUrl(
                                  apiController.text,
                                  sharedApiBaseUrl,
                                ))
                                  TextButton(
                                    onPressed: _useSharedServer,
                                    child: const Text('Use shared server'),
                                  ),
                              ],
                            ),
                          ] else if (kReleaseMode) ...[
                            const SizedBox(height: 8),
                            const Text(
                              'No shared DX public server is configured yet.',
                              style: TextStyle(color: Color(0xFFC8BFD8)),
                            ),
                          ],
                          const SizedBox(height: 12),
                          TextField(
                            controller: linkController,
                            minLines: 2,
                            maxLines: 3,
                            keyboardType: TextInputType.url,
                            decoration: _input(
                              'YouTube or Instagram link',
                              'https://www.youtube.com/watch?v=...',
                            ),
                            onSubmitted: (_) => _analyze(),
                          ),
                          const SizedBox(height: 12),
                          SizedBox(
                            width: double.infinity,
                            child: FilledButton(
                              onPressed: analyzing ? null : _analyze,
                              style: FilledButton.styleFrom(
                                backgroundColor: const Color(0xFFFF5B66),
                                padding: const EdgeInsets.symmetric(
                                  vertical: 16,
                                ),
                              ),
                              child: Text(
                                analyzing ? 'Loading...' : 'Open link',
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (error.isNotEmpty) ...[
                      const SizedBox(height: 16),
                      Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: const Color(0x22FF5B66),
                          borderRadius: BorderRadius.circular(22),
                          border: Border.all(color: const Color(0x55FF5B66)),
                        ),
                        child: Text(
                          error,
                          style: const TextStyle(color: Color(0xFFFFD6DA)),
                        ),
                      ),
                    ],
                    const SizedBox(height: 16),
                    _panel(
                      child: details == null
                          ? _emptyState()
                          : _detailsBody(details!),
                    ),
                  ],
                ),
        ),
      ),
    );
  }

  Widget _detailsBody(DxMediaDetails current) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            _chip(current.platform),
            if (current.duration != null)
              _chip(_formatDuration(current.duration!)),
            if (current.uploader.isNotEmpty) _chip(current.uploader),
          ],
        ),
        const SizedBox(height: 14),
        Text(
          current.title,
          style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800),
        ),
        if (current.description.isNotEmpty) ...[
          const SizedBox(height: 10),
          Text(
            current.description,
            style: const TextStyle(color: Color(0xFFD4CDD8)),
          ),
        ],
        const SizedBox(height: 16),
        ClipRRect(
          borderRadius: BorderRadius.circular(24),
          child: AspectRatio(
            aspectRatio:
                (current.previewWidth != null &&
                    current.previewHeight != null &&
                    current.previewHeight! > 0)
                ? current.previewWidth! / current.previewHeight!
                : 16 / 9,
            child: current.thumbnail.isNotEmpty
                ? Image.network(
                    current.thumbnail,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => _previewFallback(),
                  )
                : _previewFallback(),
          ),
        ),
        const SizedBox(height: 8),
        if (current.previewUrl.isNotEmpty)
          const Text(
            'Preview video URL is available from the backend. This mobile build shows the thumbnail and download options.',
            style: TextStyle(color: Color(0xFFC8BFD8)),
          ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (current.uploadDate.isNotEmpty)
              _chip('Date ${current.uploadDate}'),
            if (current.viewCount != null)
              _chip('Views ${_formatCount(current.viewCount!)}'),
          ],
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: ChoiceChip(
                label: const Text('Video'),
                selected: activeMode == DownloadMode.video,
                onSelected: (_) =>
                    setState(() => activeMode = DownloadMode.video),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: ChoiceChip(
                label: const Text('Audio'),
                selected: activeMode == DownloadMode.audio,
                onSelected: (_) =>
                    setState(() => activeMode = DownloadMode.audio),
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        if (activeMode == DownloadMode.video)
          ..._videoTiles(current)
        else
          _downloadTile(
            'MP3',
            'Audio',
            downloadingKey == 'audio-mp3' ? 'Preparing...' : 'Download MP3',
            downloadingKey.isNotEmpty,
            () => _download(mode: DownloadMode.audio, key: 'audio-mp3'),
          ),
        if (latestDownload != null) ...[
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0x14FFFFFF),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Latest download',
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 6),
                Text(
                  latestDownload!.path,
                  style: const TextStyle(color: Color(0xFFD4CDD8)),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _openLatestDownload,
                        child: const Text('Open file'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _copyLatestPath,
                        child: const Text('Copy path'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  List<Widget> _videoTiles(DxMediaDetails current) {
    final options = current.videoOptions.isEmpty
        ? [null]
        : current.videoOptions;
    return [
      for (var i = 0; i < options.length; i++) ...[
        _downloadTile(
          options[i]?.height == null
              ? 'Best quality'
              : '${options[i]!.height}p',
          options[i]?.label ?? 'Video',
          downloadingKey ==
                  (options[i] == null
                      ? 'video-best'
                      : 'video-${options[i]!.key}')
              ? 'Preparing...'
              : 'Download MP4',
          downloadingKey.isNotEmpty,
          () => _download(
            mode: DownloadMode.video,
            quality: options[i]?.quality,
            key: options[i] == null ? 'video-best' : 'video-${options[i]!.key}',
          ),
        ),
        if (i != options.length - 1) const SizedBox(height: 12),
      ],
    ];
  }

  Widget _downloadTile(
    String title,
    String badge,
    String subtitle,
    bool disabled,
    VoidCallback onTap,
  ) {
    return InkWell(
      onTap: disabled ? null : onTap,
      borderRadius: BorderRadius.circular(22),
      child: Ink(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: const Color(0x22FFFFFF)),
          color: const Color(0x16000000),
        ),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(999),
                  color: const Color(0x22FF8F42),
                ),
                child: Text(
                  badge,
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      subtitle,
                      style: const TextStyle(color: Color(0xFFC8BFD8)),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.download_rounded),
            ],
          ),
        ),
      ),
    );
  }

  Widget _panel({required Widget child}) {
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(30),
        border: Border.all(color: const Color(0x22FFFFFF)),
        gradient: const LinearGradient(
          colors: [Color(0xD61B1625), Color(0xC9110E18)],
        ),
        boxShadow: const [
          BoxShadow(
            color: Color(0x55000000),
            blurRadius: 24,
            offset: Offset(0, 16),
          ),
        ],
      ),
      child: Padding(padding: const EdgeInsets.all(18), child: child),
    );
  }

  InputDecoration _input(String label, String hint) => InputDecoration(
    labelText: label,
    hintText: hint,
    filled: true,
    fillColor: const Color(0xFF171421),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(22)),
  );

  Widget _chip(String text) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    decoration: BoxDecoration(
      color: const Color(0x12FFFFFF),
      borderRadius: BorderRadius.circular(999),
      border: Border.all(color: const Color(0x22FFFFFF)),
    ),
    child: Text(text),
  );

  Widget _emptyState() => const SizedBox(
    height: 220,
    child: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'Ready',
            style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800),
          ),
          SizedBox(height: 10),
          Text(
            'Paste a supported link to load the preview and download choices.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Color(0xFFC8BFD8)),
          ),
        ],
      ),
    ),
  );

  Widget _previewFallback() => const ColoredBox(
    color: Color(0xFF171421),
    child: Center(
      child: Text(
        'No preview',
        style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
      ),
    ),
  );

  String get _normalizedSharedApiBaseUrl {
    if (sharedApiBaseUrl.trim().isEmpty) {
      return '';
    }

    try {
      return _normalizeBaseUrl(sharedApiBaseUrl);
    } catch (_) {
      return '';
    }
  }

  String _normalizeBaseUrl(String input) {
    var value = input.trim();
    if (value.isEmpty) throw const DxException('Enter the backend URL first.');
    if (!value.startsWith('http://') && !value.startsWith('https://')) {
      value = '${_defaultSchemeForHost(value)}://$value';
    }
    final uri = Uri.tryParse(value);
    if (uri == null || !uri.hasScheme || uri.host.isEmpty)
      throw const DxException('Enter a valid backend URL.');
    return value.replaceFirst(RegExp(r'/+$'), '');
  }

  bool _isLocalBaseUrl(String input) {
    final raw = input.trim();
    if (raw.isEmpty) {
      return false;
    }

    final candidate = raw.startsWith('http://') || raw.startsWith('https://')
        ? raw
        : 'http://$raw';
    final uri = Uri.tryParse(candidate);

    return uri != null &&
        uri.host.isNotEmpty &&
        _looksLikeLocalHost(uri.host.toLowerCase());
  }

  bool _sameBaseUrl(String left, String right) {
    try {
      return _normalizeBaseUrl(left) == _normalizeBaseUrl(right);
    } catch (_) {
      return left.trim() == right.trim();
    }
  }

  String _defaultSchemeForHost(String input) {
    final host = input.split('/').first.split(':').first.toLowerCase();
    return _looksLikeLocalHost(host) ? 'http' : 'https';
  }

  bool _looksLikeLocalHost(String host) {
    if (host == 'localhost' ||
        host == '127.0.0.1' ||
        host == '10.0.2.2' ||
        host.endsWith('.local')) {
      return true;
    }

    final match = RegExp(
      r'^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$',
    ).firstMatch(host);
    if (match == null) {
      return false;
    }

    final parts = [
      int.tryParse(match.group(1)!),
      int.tryParse(match.group(2)!),
      int.tryParse(match.group(3)!),
      int.tryParse(match.group(4)!),
    ];

    if (parts.any((part) => part == null || part! > 255)) {
      return false;
    }

    final first = parts[0]!;
    final second = parts[1]!;

    return first == 10 ||
        first == 127 ||
        (first == 192 && second == 168) ||
        (first == 172 && second >= 16 && second <= 31);
  }

  Uri _apiUri(String baseUrl, String endpoint, [Map<String, String>? query]) {
    final base = Uri.parse(baseUrl);
    final path =
        '${base.path.endsWith('/') ? base.path.substring(0, base.path.length - 1) : base.path}${endpoint.startsWith('/') ? endpoint : '/$endpoint'}';
    return base.replace(path: path, queryParameters: query);
  }

  String _friendlyError(Object err) {
    if (err is DxException) return err.message;
    if (err is DioException) {
      final data = err.response?.data;
      if (data is Map<String, dynamic> && data['message'] is String)
        return data['message'] as String;
      if (err.type == DioExceptionType.connectionError ||
          err.type == DioExceptionType.connectionTimeout ||
          err.type == DioExceptionType.receiveTimeout) {
        if (kReleaseMode && _normalizedSharedApiBaseUrl.isEmpty) {
          return 'DX is not configured with a public server yet. Deploy the backend and update mobile/backend-config.json, or enter a working backend URL.';
        }
        return kReleaseMode
            ? 'DX could not reach the shared public server. Check that the hosted backend is live, or enter a working backend URL.'
            : 'DX could not reach the server. Check the backend URL and try again.';
      }
    }
    return 'Something went wrong.';
  }

  String _fileNameFromHeaders(
    String? contentDisposition,
    String title,
    DownloadMode mode,
  ) {
    if (contentDisposition != null) {
      final utf = RegExp(
        r"filename\*=UTF-8''([^;]+)",
        caseSensitive: false,
      ).firstMatch(contentDisposition);
      if (utf != null) return Uri.decodeComponent(utf.group(1)!);
      final plain = RegExp(
        r'filename="([^"]+)"',
        caseSensitive: false,
      ).firstMatch(contentDisposition);
      if (plain != null) return plain.group(1)!;
    }
    final safe = title.replaceAll(RegExp(r'[\\/:*?"<>|]+'), '').trim();
    final base = safe.isEmpty ? 'dx-download' : safe;
    return '$base.${mode == DownloadMode.audio ? 'mp3' : 'mp4'}';
  }

  String _formatDuration(int seconds) {
    final hours = seconds ~/ 3600;
    final minutes = (seconds % 3600) ~/ 60;
    final remaining = seconds % 60;
    return hours > 0
        ? '$hours:${minutes.toString().padLeft(2, '0')}:${remaining.toString().padLeft(2, '0')}'
        : '$minutes:${remaining.toString().padLeft(2, '0')}';
  }

  String _formatCount(int value) {
    if (value >= 1000000)
      return '${(value / 1000000).toStringAsFixed(value >= 10000000 ? 0 : 1)}M';
    if (value >= 1000)
      return '${(value / 1000).toStringAsFixed(value >= 100000 ? 0 : 1)}K';
    return '$value';
  }
}

class DxMediaDetails {
  DxMediaDetails({
    required this.url,
    required this.title,
    required this.thumbnail,
    required this.description,
    required this.uploader,
    required this.duration,
    required this.uploadDate,
    required this.viewCount,
    required this.platform,
    required this.previewUrl,
    required this.previewWidth,
    required this.previewHeight,
    required this.videoOptions,
  });

  factory DxMediaDetails.fromJson(Map<String, dynamic> json) => DxMediaDetails(
    url: _string(json['url']),
    title: _string(json['title'], fallback: 'Untitled video'),
    thumbnail: _string(json['thumbnail']),
    description: _string(json['description']),
    uploader: _string(json['uploader']),
    duration: _int(json['duration']),
    uploadDate: _string(json['uploadDate']),
    viewCount: _int(json['viewCount']),
    platform: _string(json['platform'], fallback: 'Unknown'),
    previewUrl: _string(json['previewUrl']),
    previewWidth: _int(json['previewWidth']),
    previewHeight: _int(json['previewHeight']),
    videoOptions: (json['videoOptions'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(DxVideoOption.fromJson)
        .toList(),
  );

  final String url;
  final String title;
  final String thumbnail;
  final String description;
  final String uploader;
  final int? duration;
  final String uploadDate;
  final int? viewCount;
  final String platform;
  final String previewUrl;
  final int? previewWidth;
  final int? previewHeight;
  final List<DxVideoOption> videoOptions;
}

class DxVideoOption {
  DxVideoOption({
    required this.key,
    required this.label,
    required this.quality,
    required this.height,
  });

  factory DxVideoOption.fromJson(Map<String, dynamic> json) => DxVideoOption(
    key: _string(json['key']),
    label: _string(json['label'], fallback: 'Video'),
    quality: _string(json['quality'], fallback: 'best'),
    height: _int(json['height']) ?? 0,
  );

  final String key;
  final String label;
  final String quality;
  final int height;
}

enum DownloadMode {
  video('video'),
  audio('audio');

  const DownloadMode(this.value);
  final String value;
}

class DxException implements Exception {
  const DxException(this.message);
  final String message;
}

String _string(Object? value, {String fallback = ''}) =>
    value is String && value.trim().isNotEmpty ? value.trim() : fallback;

int? _int(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value);
  return null;
}
