const DEFAULT_REPO = 'mstevens843/solana-agent-wallet-adapter';
const DEFAULT_CACHE_MS = 5 * 60 * 1000;

export type ReleaseDownloadProductId = 'cli' | 'desktop';

export interface ResolvedReleaseDownload {
  tagName: string;
  htmlUrl: string;
  publishedAt: string | null;
  assets: Record<string, string>;
}

export interface ReleaseDownloadsPayload {
  repo: string;
  resolvedAt: string;
  cache: {
    status: 'fresh' | 'stale';
    fetchedAt: string;
    maxAgeMs: number;
  };
  products: Record<ReleaseDownloadProductId, ResolvedReleaseDownload | null>;
}

interface ReleaseDownloadsBasePayload {
  repo: string;
  resolvedAt: string;
  products: Record<ReleaseDownloadProductId, ResolvedReleaseDownload | null>;
}

interface CachedReleaseDownloads {
  payload: ReleaseDownloadsBasePayload;
  fetchedAtMs: number;
}

interface GitHubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  created_at?: unknown;
  assets?: unknown;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<FetchResponseLike>;

const PRODUCT_DEFINITIONS: Record<ReleaseDownloadProductId, { tagPrefix: string; assets: readonly string[] }> = {
  cli: {
    tagPrefix: 'cli-v',
    assets: [
      'solana-agent-wallet-macos-arm64.tar.gz',
      'solana-agent-wallet-macos-x64.tar.gz',
      'solana-agent-wallet-linux-x64.tar.gz',
      'solana-agent-wallet-windows-x64.zip',
    ],
  },
  desktop: {
    tagPrefix: 'desktop-v',
    assets: [
      'agentic-desktop-macos-arm64.dmg',
      'agentic-desktop-macos-x64.dmg',
      'agentic-desktop-windows-x64.msi',
      'agentic-desktop-linux-x64.AppImage',
    ],
  },
};

let releaseDownloadsCache: CachedReleaseDownloads | null = null;

export function clearReleaseDownloadsCache(): void {
  releaseDownloadsCache = null;
}

export async function resolveReleaseDownloads(): Promise<ReleaseDownloadsPayload> {
  const repo = releaseDownloadsRepo();
  const nowMs = Date.now();
  const cacheMs = releaseDownloadsCacheMs();
  if (
    releaseDownloadsCache &&
    releaseDownloadsCache.payload.repo === repo &&
    nowMs - releaseDownloadsCache.fetchedAtMs < cacheMs
  ) {
    return withCacheMetadata(releaseDownloadsCache, 'fresh', cacheMs);
  }

  try {
    const releases = await fetchGitHubReleases(repo);
    const basePayload: ReleaseDownloadsBasePayload = {
      repo,
      resolvedAt: new Date(nowMs).toISOString(),
      products: {
        cli: pickProductRelease(releases, PRODUCT_DEFINITIONS.cli),
        desktop: pickProductRelease(releases, PRODUCT_DEFINITIONS.desktop),
      },
    };
    releaseDownloadsCache = { payload: basePayload, fetchedAtMs: nowMs };
    return withCacheMetadata(releaseDownloadsCache, 'fresh', cacheMs);
  } catch (err) {
    if (releaseDownloadsCache?.payload.repo === repo) {
      return withCacheMetadata(releaseDownloadsCache, 'stale', cacheMs);
    }
    throw err;
  }
}

async function fetchGitHubReleases(repo: string): Promise<GitHubRelease[]> {
  const fetchImpl = globalThis.fetch as FetchLike | undefined;
  if (!fetchImpl) {
    throw new Error('fetch is not available in this runtime.');
  }
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'agentic-release-download-resolver',
    'x-github-api-version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub releases request failed with HTTP ${response.status}.`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error('GitHub releases response was not an array.');
  }
  return payload as GitHubRelease[];
}

function pickProductRelease(
  releases: GitHubRelease[],
  definition: { tagPrefix: string; assets: readonly string[] },
): ResolvedReleaseDownload | null {
  const candidates = releases
    .map((release) => {
      if (release.draft || release.prerelease) return null;
      const tagName = stringValue(release.tag_name);
      const version = parseProductVersion(tagName, definition.tagPrefix);
      if (!version) return null;
      const htmlUrl = stringValue(release.html_url);
      if (!htmlUrl) return null;
      const assets = releaseAssetsByName(release.assets);
      for (const assetName of definition.assets) {
        if (!assets[assetName]) return null;
      }
      return {
        version,
        publishedAt: stringValue(release.published_at) || stringValue(release.created_at) || null,
        release: {
          tagName,
          htmlUrl,
          publishedAt: stringValue(release.published_at) || stringValue(release.created_at) || null,
          assets: Object.fromEntries(definition.assets.map((assetName) => [assetName, assets[assetName]!])),
        } satisfies ResolvedReleaseDownload,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

  candidates.sort((left, right) => {
    const versionOrder = compareSemver(right.version, left.version);
    if (versionOrder !== 0) return versionOrder;
    return dateMs(right.publishedAt) - dateMs(left.publishedAt);
  });
  return candidates[0]?.release ?? null;
}

function releaseAssetsByName(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const assets: Record<string, string> = {};
  for (const asset of value as GitHubReleaseAsset[]) {
    const name = stringValue(asset.name);
    const url = stringValue(asset.browser_download_url);
    if (name && url) assets[name] = url;
  }
  return assets;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseProductVersion(tagName: string, tagPrefix: string): Semver | null {
  if (!tagName.startsWith(tagPrefix)) return null;
  const rawVersion = tagName.slice(tagPrefix.length);
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(rawVersion);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(left: Semver, right: Semver): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function withCacheMetadata(
  cache: CachedReleaseDownloads,
  status: ReleaseDownloadsPayload['cache']['status'],
  maxAgeMs: number,
): ReleaseDownloadsPayload {
  return {
    ...cache.payload,
    cache: {
      status,
      fetchedAt: new Date(cache.fetchedAtMs).toISOString(),
      maxAgeMs,
    },
  };
}

function releaseDownloadsRepo(): string {
  const repo = process.env.AGENTIC_RELEASE_REPO?.trim();
  return repo || DEFAULT_REPO;
}

function releaseDownloadsCacheMs(): number {
  const raw = process.env.AGENTIC_RELEASE_DOWNLOAD_CACHE_MS;
  if (!raw) return DEFAULT_CACHE_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CACHE_MS;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function dateMs(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
