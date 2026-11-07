import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  configurationExportKind,
  type ConfigurationAppearance,
  type ConfigurationApiKeyState,
  type ConfigurationExport,
  type ConfigurationExportRepository,
  type ConfigurationImportCandidate,
  type ConfigurationImportPreview,
  type ConfigurationImportResult,
  type ConfigurationImportSettings,
  type ConfigurationSettingsResult,
  type ProfileConfig,
  type RepositoriesConfig,
  type RepositoryConfig,
} from '../../shared/contracts.js';
import { parseRemoteUrl } from '../../shared/remote-url.js';
import { mapWithConcurrency } from '../concurrency.js';
import {
  isPathInside,
  loadProfile,
  loadRepositories,
  resolveRepositoryPath,
  resolveRoot,
  updateProfile,
  updateRepositories,
} from './store.js';
import { invalidRequestError } from '../errors.js';
import { cloneRepositoryIntoRoot } from '../git/clone.js';
import { readRemoteUrl } from '../git/remotes.js';
import { sanitizeRemote } from '../git/scanner.js';
import { appendRepositoryConfig } from '../repositories/service.js';
import { loadDeepSeekApiKey, saveDeepSeekApiKey } from '../ai/provider.js';

/**
 * 跨机配置迁移：导出本机仓库清单（含每个仓库的远端地址）与界面 / AI 设置，
 * 在另一台电脑上选一个根目录后，把「本地没有」的仓库从远端克隆回来。
 *
 * 为什么远端地址必须进导出包：`config/repositories.yaml` 只记 `root` + 相对路径，
 * 远端只存在于各仓库的 `.git/config`。换台电脑这份信息就没有了，而它恰好是
 * 「A 机有、B 机没有」时唯一能重建仓库的依据。
 *
 * 三条不变量：
 * 1. **只增不删**——仓库导入只会 `git clone` 与写配置，绝不改动、覆盖或删除磁盘上
 *    已有的任何目录（目标目录被占用一律判 `conflict`）。界面与 AI 设置是另一回事：
 *    那是用户显式勾选的「覆盖本机偏好」，只在应用设置那一步发生。
 * 2. **git 凭证不导出**——远端地址先过 `sanitizeRemote`，URL 里内嵌的令牌不会写进文件。
 *    DeepSeek Key 要导出（换机器后没有它就生成不了 Commit 文案），因此导出文件本身
 *    是**敏感文件**，界面必须提醒用户别外传。
 * 3. **一次只做一条**——克隆大的仓库可能要几分钟，整批塞进一个请求必然撞 HTTP
 *    超时；客户端串行逐条调用，进度与失败原因都按条回报。
 */

/** 目标目录名只允许单层：拒绝路径分隔符、`.`/`..`、前导 `-` 与控制字符。 */
function safeDirectoryName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  if (trimmed.startsWith('-')) return null;
  // eslint-disable-next-line no-control-regex -- 这条正则就是用来拒绝控制字符
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (/[/\\]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * 远端身份：`host/path`（去 `.git`、小写）。
 *
 * 只用来判断「两台机器上的两个地址是不是同一个仓库」。协议、用户名与端口都不参与，
 * 因为同一仓库在不同机器上常常一个是 `git@host:o/r.git`、另一个是 `https://host/o/r`。
 */
export function remoteIdentity(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const parsed = parseRemoteUrl(remote);
  if (!parsed.ok) return null;
  // 先削尾斜杠再削 `.git`。顺序反过来时 `…/demo.git/` 会留下 `demo.git`，
  // 于是同一个仓库因为一个尾斜杠被判成不同身份：预览会说「将克隆」（重复拉一份），
  // 或者反过来把本地已有的判成「冲突」而挡住导入。
  const remotePath = parsed.shape.path
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!remotePath) return null;
  return `${parsed.shape.host.toLowerCase()}/${remotePath}`;
}

/** 目标相对路径：沿用源路径的最后一段；多级路径会摊平成单层并在预览里说明。 */
function targetPathFor(entry: ConfigurationExportRepository): { relativePath: string; flattened: string | null } | null {
  const segments = entry.path
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.');
  const last = segments[segments.length - 1] ?? '';
  const relativePath = safeDirectoryName(last) ?? safeDirectoryName(entry.name);
  if (!relativePath) return null;
  return {
    relativePath,
    flattened: segments.length > 1 ? segments.join('/') : null,
  };
}

/**
 * 候选键：稳定、定长、不可猜。
 *
 * 早先直接把 `路径|名字|远端身份` 拼成键，但远端地址允许到 2048 字符，拼出来的键
 * 会超过请求 schema 的 400 字符上限——那一条导入就会以「请求不合法」失败，报错还
 * 完全指不到真正的原因。这里改成对同一份输入取摘要：预览与逐条导入本地各算一次，
 * 结果必然一致；键对客户端是不透明的，客户端只回传。
 */
function candidateKey(entry: ConfigurationExportRepository, relativePath: string, seen: Map<string, number>): string {
  const base = [
    relativePath.toLowerCase(),
    entry.name.toLowerCase(),
    remoteIdentity(entry.remote) ?? '',
  ].join('|');
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  // 同一份导出里可能出现完全相同的两条（同目录、同名、同远端）：加序号区分，
  // 否则两次导入会指向同一条，第二条静默变成 existing。
  const digest = createHash('sha256').update(base).digest('hex').slice(0, 24);
  return count === 1 ? digest : `${digest}-${count}`;
}

/** 已登记的仓库快照：真实路径 + 远端身份，用于「是不是已经在工作台里」。 */
interface RegisteredRepository {
  id: string;
  name: string;
  canonicalPath: string;
  identity: string | null;
  /** 目录还在不在。被外部删掉的登记不算「已有」，否则迁移没法把它找回来。 */
  exists: boolean;
}

async function registeredRepositories(config: RepositoriesConfig): Promise<RegisteredRepository[]> {
  const concurrency = Math.max(1, config.settings.localScanConcurrency);
  return mapWithConcurrency(config.repositories, concurrency, async (repository) => {
    const absolutePath = resolveRepositoryPath(config, repository);
    // realpath 只在路径真实存在时成功，正好当作「目录还在」的判定。
    const canonical = await realpath(absolutePath).catch(() => null);
    const remote = canonical ? await readRemoteUrl(absolutePath, config.settings.defaultRemote).catch(() => '') : '';
    return {
      id: repository.id,
      name: repository.name,
      canonicalPath: canonical ?? path.resolve(absolutePath),
      identity: remoteIdentity(remote),
      exists: canonical !== null,
    };
  });
}

/**
 * 已登记仓库的**真实路径**索引。
 *
 * 导入单条时只关心「这个落点是不是已经被登记过」，不需要每个仓库的远端身份——
 * 身份判定放在预览里做（那里本来就要读远端）。这样一次导入请求里除了克隆本身
 * 不再起任何 git 子进程，逐条循环才不会被 54 个仓库 × N 次请求拖慢。
 */
async function registeredCanonicalPaths(config: RepositoriesConfig): Promise<Map<string, RepositoryConfig>> {
  const index = new Map<string, RepositoryConfig>();
  for (const repository of config.repositories) {
    const absolutePath = resolveRepositoryPath(config, repository);
    const canonicalPath = await realpath(absolutePath).catch(() => null);
    // 目录已被删掉的登记不参与「是否已导入」的判定：迁移正是用来把它拉回来的。
    if (!canonicalPath) continue;
    if (!index.has(canonicalPath)) index.set(canonicalPath, repository);
  }
  return index;
}

/** 根目录 id → 真实路径：`settings.roots` 里可能是符号链接写法，比较路径前先归一。 */
async function canonicalRootPaths(config: RepositoriesConfig): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const [id, rootPath] of Object.entries(config.settings.roots)) {
    map.set(id, await realpath(rootPath).catch(() => path.resolve(rootPath)));
  }
  return map;
}

/**
 * 配置里落在同一路径上的条目——通常只在「目录被外部删掉、登记还留着」时才命中。
 * 复用它（保留 id 与排序）比再塞一条重复登记干净。
 */
function findRepositoryAtPath(
  config: RepositoriesConfig,
  roots: Map<string, string>,
  targetPath: string,
): RepositoryConfig | undefined {
  return config.repositories.find((repository) => {
    const root = roots.get(repository.root);
    if (!root) return false;
    return path.resolve(root, repository.path) === targetPath;
  });
}

async function exportRepositoryRemote(
  config: RepositoriesConfig,
  repository: RepositoryConfig,
): Promise<string | null> {
  const absolutePath = resolveRepositoryPath(config, repository);
  const remote = await readRemoteUrl(absolutePath, config.settings.defaultRemote).catch(() => '');
  return remote ? sanitizeRemote(remote) : null;
}

/** 导出时机读的「本机偏好」；抽成依赖是为了单测不去碰用户真实的 profile 与 Key 文件。 */
export interface ExportDeps {
  loadProfile: () => Promise<ProfileConfig>;
  readApiKey: () => Promise<string | null>;
}

const defaultExportDeps: ExportDeps = {
  loadProfile,
  readApiKey: loadDeepSeekApiKey,
};

/** 只挑外观相关的字段：排序、筛选、分析范围这些是看当下仓库列表的临时视角。 */
function appearanceOf(profile: ProfileConfig): ConfigurationAppearance {
  const preferences = profile.profile.viewPreferences;
  return {
    theme: profile.profile.theme,
    ...(preferences.interfaceFont ? { interfaceFont: preferences.interfaceFont } : {}),
    ...(preferences.interfaceFontSize ? { interfaceFontSize: preferences.interfaceFontSize } : {}),
    ...(preferences.codeFont ? { codeFont: preferences.codeFont } : {}),
    ...(preferences.codeFontSize ? { codeFontSize: preferences.codeFontSize } : {}),
  };
}

export async function exportConfiguration(
  config: RepositoriesConfig,
  deps: ExportDeps = defaultExportDeps,
): Promise<ConfigurationExport> {
  const concurrency = Math.max(1, config.settings.localScanConcurrency);
  const repositories = await mapWithConcurrency(config.repositories, concurrency, async (repository) => {
    const remote = await exportRepositoryRemote(config, repository);
    return {
      name: repository.name,
      group: repository.group,
      tags: [...repository.tags],
      pinned: repository.pinned,
      enabled: repository.enabled,
      aiCommitPolicy: repository.aiCommitPolicy,
      capabilities: { ...repository.capabilities },
      root: repository.root,
      path: repository.path,
      remote,
    } satisfies ConfigurationExportRepository;
  });

  // Key 读不出来（权限坏了）不该让整份导出失败：仓库清单仍然是有用的，
  // 界面会在应用设置时按「没有 Key」处理，用户回去修一下再导一次即可。
  const [profile, apiKey] = await Promise.all([
    deps.loadProfile(),
    deps.readApiKey().catch(() => null),
  ]);

  return {
    kind: configurationExportKind,
    version: 1,
    exportedAt: new Date().toISOString(),
    machine: os.hostname(),
    roots: { ...config.settings.roots },
    repositories,
    appearance: appearanceOf(profile),
    ai: { apiKey: apiKey?.trim() || null },
  };
}

/** 目标路径当前是什么形态：不存在 / Git 工作树 / 被别的东西占着。 */
type TargetState =
  | { kind: 'missing' }
  | { kind: 'git'; remote: string | null }
  | { kind: 'occupied'; reason: string };

async function inspectTarget(absolutePath: string, defaultRemote: string): Promise<TargetState> {
  const info = await stat(absolutePath).catch(() => null);
  if (!info) return { kind: 'missing' };
  if (!info.isDirectory()) return { kind: 'occupied', reason: '目标路径已被一个文件占用' };
  // 与 scanner 的判定一致：worktree 根目录的 `.git` 是目录，worktree / submodule 是
  // 内容为 `gitdir: <路径>` 的文件。两种都算 Git 工作树。
  const gitEntry = await stat(path.join(absolutePath, '.git')).catch(() => null);
  if (!gitEntry) return { kind: 'occupied', reason: '目标目录已存在但不是 Git 仓库' };
  const remote = await readRemoteUrl(absolutePath, defaultRemote).catch(() => '');
  return { kind: 'git', remote: remote ? remote : null };
}

/** 导出包里的 Key 与本机的关系；只回状态，绝不把 Key 回传给客户端。 */
function apiKeyState(payload: ConfigurationExport, localApiKey: string | null): ConfigurationApiKeyState {
  const incoming = payload.ai?.apiKey?.trim();
  if (!incoming) return 'none';
  if (!localApiKey) return 'new';
  return incoming === localApiKey ? 'same' : 'overwrite';
}

function settingsOf(payload: ConfigurationExport, localApiKey: string | null): ConfigurationImportSettings {
  return {
    appearance: payload.appearance ? { ...payload.appearance } : null,
    apiKeyState: apiKeyState(payload, localApiKey),
  };
}

export async function previewConfigurationImport(
  config: RepositoriesConfig,
  payload: ConfigurationExport,
  rootId: string,
  localApiKey: string | null = null,
): Promise<ConfigurationImportPreview> {
  const rootPath = await resolveRoot(config, rootId);
  const defaultRemote = config.settings.defaultRemote;
  const registered = await registeredRepositories(config);
  // 只剩「目录还在」的登记参与匹配：目录没了的那条应该被当成待克隆，否则用户
  // 明明丢了这个仓库，预览却告诉他「已在工作台」。
  const registeredByPath = new Map(
    registered.filter((entry) => entry.exists).map((entry) => [entry.canonicalPath, entry]),
  );
  const registeredByIdentity = new Map(
    registered
      .filter((entry): entry is RegisteredRepository & { identity: string } => Boolean(entry.identity))
      .map((entry) => [entry.identity, entry]),
  );

  const seen = new Map<string, number>();
  const candidates: ConfigurationImportCandidate[] = [];

  for (const [index, entry] of payload.repositories.entries()) {
    const resolvedTarget = targetPathFor(entry);
    const relativePath = resolvedTarget?.relativePath ?? `__invalid-${index}__`;
    const key = candidateKey(entry, relativePath, seen);
    if (!resolvedTarget) {
      candidates.push({
        key,
        name: entry.name,
        group: entry.group,
        tags: [...entry.tags],
        sourcePath: entry.path,
        relativePath,
        targetPath: '',
        remote: entry.remote ? sanitizeRemote(entry.remote) : null,
        status: 'conflict',
        detail: '导出记录里的目录名不合法（含路径分隔符、`..` 或前导 `-`），已跳过',
        repositoryId: null,
      });
      continue;
    }
    const { flattened } = resolvedTarget;
    const targetPath = path.resolve(rootPath, relativePath);
    if (!isPathInside(rootPath, targetPath)) {
      candidates.push({
        key,
        name: entry.name,
        group: entry.group,
        tags: [...entry.tags],
        sourcePath: entry.path,
        relativePath,
        targetPath,
        remote: entry.remote ? sanitizeRemote(entry.remote) : null,
        status: 'conflict',
        detail: '目标路径超出所选根目录',
        repositoryId: null,
      });
      continue;
    }

    const canonicalTarget = await realpath(targetPath).catch(() => targetPath);
    const identity = remoteIdentity(entry.remote);
    const base = {
      key,
      name: entry.name,
      group: entry.group,
      tags: [...entry.tags],
      sourcePath: entry.path,
      relativePath,
      targetPath,
      // 只用于展示：导入时始终用载荷里的原始地址去克隆。手改过的文件可能把
      // `user:token@` 写回来，不该让它出现在界面上（截图、投屏都会带出去）。
      remote: entry.remote ? sanitizeRemote(entry.remote) : null,
    };

    const samePath = registeredByPath.get(canonicalTarget);
    if (samePath) {
      candidates.push({
        ...base,
        status: 'existing',
        detail: `已在工作台中（${samePath.name}）`,
        repositoryId: samePath.id,
      });
      continue;
    }
    const sameRemote = identity ? registeredByIdentity.get(identity) : undefined;
    if (sameRemote) {
      candidates.push({
        ...base,
        status: 'existing',
        detail: `同一远端已登记为「${sameRemote.name}」，路径为 ${sameRemote.canonicalPath}`,
        repositoryId: sameRemote.id,
      });
      continue;
    }

    const target = await inspectTarget(targetPath, defaultRemote);
    const flattenNote = flattened ? `源路径 ${flattened} 将落到 ${relativePath}；` : '';

    if (target.kind === 'missing') {
      candidates.push(
        entry.remote
          ? { ...base, status: 'clone', detail: `${flattenNote}目录不存在，将从远端克隆`, repositoryId: null }
          : {
              ...base,
              status: 'no-remote',
              detail: `${flattenNote}目录不存在且导出记录里没有远端地址，无法重建`,
              repositoryId: null,
            },
      );
      continue;
    }

    if (target.kind === 'git') {
      const localIdentity = remoteIdentity(target.remote);
      if (identity && localIdentity && identity !== localIdentity) {
        candidates.push({
          ...base,
          status: 'conflict',
          detail: `目标目录的 origin 指向 ${localIdentity}，与导出记录的 ${identity} 不一致`,
          repositoryId: null,
        });
        continue;
      }
      candidates.push({
        ...base,
        status: 'link',
        detail: `${flattenNote}本地已有该仓库，只需登记`,
        repositoryId: null,
      });
      continue;
    }

    candidates.push({
      ...base,
      status: 'conflict',
      detail: `${flattenNote}${target.reason}`,
      repositoryId: null,
    });
  }

  const countBy = (status: ConfigurationImportCandidate['status']) =>
    candidates.filter((candidate) => candidate.status === status).length;

  return {
    sourceMachine: payload.machine,
    exportedAt: payload.exportedAt,
    rootId,
    rootPath,
    total: candidates.length,
    counts: {
      existing: countBy('existing'),
      link: countBy('link'),
      clone: countBy('clone'),
      noRemote: countBy('no-remote'),
      conflict: countBy('conflict'),
    },
    candidates,
    settings: settingsOf(payload, localApiKey),
  };
}

function findEntry(payload: ConfigurationExport, key: string): {
  entry: ConfigurationExportRepository;
  relativePath: string;
} {
  const seen = new Map<string, number>();
  for (const [index, entry] of payload.repositories.entries()) {
    const resolvedTarget = targetPathFor(entry);
    const relativePath = resolvedTarget?.relativePath ?? `__invalid-${index}__`;
    if (candidateKey(entry, relativePath, seen) !== key) continue;
    if (!resolvedTarget) throw invalidRequestError('该导入项的目录名不合法，无法导入');
    return { entry, relativePath };
  }
  throw invalidRequestError('导入项已失效，请重新预览');
}

/**
 * 导入一条：必要时克隆，然后登记进配置。
 *
 * 失败**不抛错**（除了请求本身不合法）：这一条失败不该中断客户端正在跑的整轮导入，
 * 调用方要能逐条展示原因。破坏性前置条件（目录被占用、不是 Git 仓库）在这里
 * 一律拒绝，不做任何「先删掉再克隆」的补救。
 *
 * 配置读写通过 `deps` 注入：路由用 store 的真实现，测试用内存桩。否则单测会读写
 * 用户真实的 `config/repositories.yaml`（`GIT_FLEET_HOME` 未设时就是仓库根目录）。
 */
export interface ImportEntryDeps {
  loadConfig: () => Promise<RepositoriesConfig>;
  updateConfig: (update: (current: RepositoriesConfig) => Promise<RepositoriesConfig>) => Promise<RepositoriesConfig>;
}

const defaultImportDeps: ImportEntryDeps = {
  loadConfig: loadRepositories,
  updateConfig: updateRepositories,
};

export async function importConfigurationEntry(
  payload: ConfigurationExport,
  rootId: string,
  key: string,
  deps: ImportEntryDeps = defaultImportDeps,
): Promise<ConfigurationImportResult> {
  const { entry, relativePath } = findEntry(payload, key);
  const config = await deps.loadConfig();
  const rootPath = await resolveRoot(config, rootId);
  const targetPath = path.resolve(rootPath, relativePath);
  if (!isPathInside(rootPath, targetPath)) {
    throw invalidRequestError('目标路径超出所选根目录');
  }

  const registered = await registeredCanonicalPaths(config);
  const canonicalTarget = await realpath(targetPath).catch(() => targetPath);
  const alreadyRegistered = registered.get(canonicalTarget);
  if (alreadyRegistered) {
    return {
      key,
      name: entry.name,
      status: 'existing',
      message: `已在工作台中（${alreadyRegistered.name}）`,
      repositoryId: alreadyRegistered.id,
    };
  }

  const target = await inspectTarget(targetPath, config.settings.defaultRemote);
  let cloned = false;
  if (target.kind === 'missing') {
    if (!entry.remote) {
      return {
        key,
        name: entry.name,
        status: 'failed',
        message: '导出记录里没有远端地址，无法克隆；请在源机器上补一个远端后重新导出',
        repositoryId: null,
      };
    }
    try {
      await cloneRepositoryIntoRoot(config, { rootId, url: entry.remote, directory: relativePath });
      cloned = true;
    } catch (error) {
      return {
        key,
        name: entry.name,
        status: 'failed',
        message: error instanceof Error ? error.message : '克隆失败',
        repositoryId: null,
      };
    }
  } else if (target.kind === 'occupied') {
    return { key, name: entry.name, status: 'failed', message: target.reason, repositoryId: null };
  } else {
    const identity = remoteIdentity(entry.remote);
    const localIdentity = remoteIdentity(target.remote);
    if (identity && localIdentity && identity !== localIdentity) {
      return {
        key,
        name: entry.name,
        status: 'failed',
        message: `目标目录的 origin 指向 ${localIdentity}，与导出记录的 ${identity} 不一致`,
        repositoryId: null,
      };
    }
  }

  try {
    let repository!: RepositoryConfig;
    let revived = false;
    await deps.updateConfig(async (current) => {
      // 「目录被删掉、登记还留着」的仓库：刚克隆回来的正是它登记过的那个路径。
      // 复用原条目（保留 id 与排序）比再塞一条重复登记干净，也避免
      // `appendRepositoryConfig` 以「该仓库已经在列表中」拒绝——那会变成
      // 「克隆成功了但导入报失败」。
      const roots = await canonicalRootPaths(current);
      const stale = findRepositoryAtPath(current, roots, targetPath);
      if (stale) {
        stale.name = entry.name;
        stale.group = entry.group;
        stale.tags = [...entry.tags];
        stale.pinned = entry.pinned;
        stale.enabled = entry.enabled;
        stale.aiCommitPolicy = entry.aiCommitPolicy;
        stale.capabilities = { ...entry.capabilities };
        repository = stale;
        revived = true;
        return current;
      }
      repository = await appendRepositoryConfig(current, {
        rootId,
        relativePath,
        name: entry.name,
        group: entry.group,
        tags: [...entry.tags],
      });
      // `appendRepositoryConfig` 只填默认值；置顶、启用、AI 策略与能力开关属于
      // 「配置」的一部分，跨机导入要一并带过来，否则用户会以为导出漏了字段。
      // 能力开关尤其不能漏：它决定这台机器上能不能对这个仓库做 commit / push，
      // 静默放开等于把源机器上设的护栏拆掉。
      repository.pinned = entry.pinned;
      repository.enabled = entry.enabled;
      repository.aiCommitPolicy = entry.aiCommitPolicy;
      repository.capabilities = { ...entry.capabilities };
      return current;
    });
    const message = revived
      ? cloned
        ? '目录此前缺失，已从远端克隆并恢复原有登记'
        : '目录此前缺失，已恢复原有登记'
      : cloned
        ? '已从远端克隆并加入工作台'
        : '已登记本地已有仓库';
    return {
      key,
      name: entry.name,
      status: cloned ? 'cloned' : 'linked',
      message,
      repositoryId: repository.id,
    };
  } catch (error) {
    return {
      key,
      name: entry.name,
      status: 'failed',
      message: error instanceof Error ? error.message : '写入配置失败',
      repositoryId: null,
    };
  }
}

/**
 * 应用导出包里的界面外观与 DeepSeek Key。
 *
 * 与仓库导入分开成一步，是因为它是**唯一会覆盖本机已有设置**的动作：主题、字体、
 * Key 都会就地替换。界面上它对应一个独立勾选项，用户明确选了才调这个接口。
 *
 * 只改外观字段：排序、筛选、分析范围留在本机（那是「看这批仓库」的临时视角，
 * 不是配置）。Key 与本机一致时不重写，免得白改文件时间戳。
 */
export interface ApplySettingsDeps {
  updateProfile: (update: (current: ProfileConfig) => ProfileConfig) => Promise<ProfileConfig>;
  readApiKey: () => Promise<string | null>;
  writeApiKey: (apiKey: string) => Promise<void>;
}

const defaultApplyDeps: ApplySettingsDeps = {
  updateProfile,
  readApiKey: loadDeepSeekApiKey,
  writeApiKey: saveDeepSeekApiKey,
};

export async function applyConfigurationSettings(
  payload: ConfigurationExport,
  deps: ApplySettingsDeps = defaultApplyDeps,
): Promise<ConfigurationSettingsResult> {
  const appearance = payload.appearance ? { ...payload.appearance } : null;
  const incomingKey = payload.ai?.apiKey?.trim() || null;
  if (!appearance && !incomingKey) {
    throw invalidRequestError('这份配置文件里没有界面或 AI 设置');
  }

  if (appearance) {
    await deps.updateProfile((current) => {
      // 外观是**整体**而不是补丁：导出包里没有的字体字段要清掉，落到「跟随默认」，
      // 否则目标机器会留着旧字号，看起来像是迁移漏了字段。
      const preferences = { ...current.profile.viewPreferences };
      if (appearance.interfaceFont) preferences.interfaceFont = appearance.interfaceFont;
      else delete preferences.interfaceFont;
      if (appearance.interfaceFontSize) preferences.interfaceFontSize = appearance.interfaceFontSize;
      else delete preferences.interfaceFontSize;
      if (appearance.codeFont) preferences.codeFont = appearance.codeFont;
      else delete preferences.codeFont;
      if (appearance.codeFontSize) preferences.codeFontSize = appearance.codeFontSize;
      else delete preferences.codeFontSize;

      return {
        ...current,
        profile: {
          ...current.profile,
          theme: appearance.theme,
          viewPreferences: preferences,
        },
      };
    });
  }

  let apiKeyApplied = false;
  let apiKeyEffective = true;
  if (incomingKey) {
    const localKey = await deps.readApiKey().catch(() => null);
    if (localKey !== incomingKey) {
      await deps.writeApiKey(incomingKey);
      apiKeyApplied = true;
      // 写完再读一次。读回来的仍是别的值，说明有更高优先级的来源在覆盖
      // （`GIT_FLEET_AI_API_KEY` 环境变量优先于文件），必须如实告诉用户，
      // 不能让他以为「已应用」就等于「已生效」。
      const afterWrite = await deps.readApiKey().catch(() => null);
      apiKeyEffective = afterWrite === incomingKey;
    }
  }

  const parts: string[] = [];
  if (appearance) parts.push(`已应用主题 ${appearance.theme}`);
  if (apiKeyApplied && apiKeyEffective) parts.push('DeepSeek Key 已写入本机');
  else if (apiKeyApplied) parts.push('DeepSeek Key 已写入文件，但当前进程由 GIT_FLEET_AI_API_KEY 提供，实际生效的仍是环境变量');
  else if (incomingKey) parts.push('DeepSeek Key 与本机一致');

  return { appearance, apiKeyApplied, apiKeyEffective, message: parts.join('，') };
}
