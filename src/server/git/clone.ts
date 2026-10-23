import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RepositoriesConfig } from '../../shared/contracts.js';
import { normalizeRemoteUrlInput, parseRemoteTarget, suggestedDirectoryName } from '../../shared/remote-url.js';
import { isPathInside, resolveRoot } from '../config/store.js';
import { conflictError, invalidRequestError } from '../errors.js';
import { runGit, runGitText } from './runner.js';

/**
 * 克隆远端仓库到已登记的根目录下。
 *
 * 为什么需要它：接入仓库此前只能「登记已存在的本地路径」——`POST /api/repositories` 接受的是
 * `rootId + relativePath`，`appendRepositoryConfig` 还会先 `realpath` 确认目录存在。
 * 于是想 clone 一个新仓库，只能回终端敲 git；连界面上的文案都写着
 * 「先在 Gitee / GitHub 建一个空的私有仓库…clone 到本机，再回来选中它」。
 *
 * 安全边界：
 * 1. 地址走共享的 `parseRemoteTarget`（与远端管理同一份判定）；
 * 2. 目标目录名只允许**单层**：拒绝路径分隔符、`.`、`..` 与前导 `-`——
 *    把「写到根目录之外」直接堵在入口，而不是只靠后面的 `isPathInside` 兜底；
 * 3. 目标目录必须不存在（不覆盖任何已有内容），失败时如实说明半成品目录的去向；
 * 4. 克隆成功后再由调用方写配置，保证「配置文件里出现的仓库都真实存在」这条不变量。
 *
 * 只做「克隆 + 校验」，**不写配置**：写配置是路由层的事（与新增仓库的既有流程一致）。
 */

const cloneTimeoutMs = 900_000;

/** 目标目录名只允许单层，且不能是会被 git 当选项解析的形态。 */
function ensureDirectoryName(raw: string): string {
  const value = raw.trim();
  if (!value) throw invalidRequestError('请填写目标目录名');
  // eslint-disable-next-line no-control-regex -- 这条正则就是用来拒绝控制字符的
  if (/[\u0000-\u001f\u007f]/.test(value)) throw invalidRequestError('目标目录名不能包含控制字符或换行');
  if (value.startsWith('-')) throw invalidRequestError('目标目录名不能以「-」开头');
  if (value === '.' || value === '..') throw invalidRequestError('目标目录名不能是「.」或「..」');
  if (/[/\\]/.test(value)) throw invalidRequestError('目标目录名只能是单层目录，不能包含路径分隔符');
  return value;
}

export interface CloneRepositoryInput {
  /** 目标根目录的 id（必须已在配置里登记）。 */
  rootId: string;
  url: string;
  /** 目标目录名（相对根目录）；省略时从地址推断。 */
  directory?: string;
}

export interface CloneRepositoryOutput {
  /** 实际使用的目录名（相对根目录），调用方据此登记仓库。 */
  directory: string;
  /** 完整路径，供结果提示。 */
  absolutePath: string;
}

export async function cloneRepositoryIntoRoot(
  config: RepositoriesConfig,
  input: CloneRepositoryInput,
): Promise<CloneRepositoryOutput> {
  const target = parseRemoteTarget(input.url);
  if (!target.ok) throw invalidRequestError(target.reason);
  // 与校验用同一份规范化：校验通过的是去掉引号后的地址，`git clone` 也必须用它，
  // 否则会出现「校验说没问题、git 却拿到带引号的地址」。
  const url = normalizeRemoteUrlInput(input.url);

  const rootPath = await resolveRoot(config, input.rootId);
  const requested = input.directory?.trim() || suggestedDirectoryName(url);
  if (!requested) throw invalidRequestError('无法从地址推断目标目录名，请手动填写');
  const directory = ensureDirectoryName(requested);
  const absolutePath = path.join(rootPath, directory);
  if (!isPathInside(rootPath, absolutePath)) throw invalidRequestError('目标目录超出允许的根目录');

  // 先自己确认目标不存在，再动手：否则要让用户去读 git 那句「destination path already exists」。
  const occupied = await stat(absolutePath).then(() => true).catch(() => false);
  if (occupied) throw conflictError(`目标目录已存在：${absolutePath}`);

  const result = await runGit(rootPath, ['clone', url, directory], cloneTimeoutMs);
  if (result.exitCode !== 0) {
    const message = (result.stderr || result.stdout.toString('utf8')).trim() || '克隆失败';
    // git 失败时一般会自己清掉半成品。没清掉就如实报出目录还在，绝不静默留垃圾。
    const leftover = await stat(absolutePath).then(() => true).catch(() => false);
    if (!leftover) throw conflictError(message);
    const cleaned = await rm(absolutePath, { recursive: true, force: true })
      .then(() => true)
      .catch(() => false);
    throw conflictError(
      cleaned
        ? `${message}（未完成的目录已清理）`
        : `${message}；未完成的目录仍留在 ${absolutePath}，请手动删除后再试`,
    );
  }

  const topLevel = await runGitText(absolutePath, ['rev-parse', '--show-toplevel']).catch(() => '');
  if (!topLevel) throw new Error('克隆结束但目标目录不是有效的 Git 仓库');
  return { directory, absolutePath };
}
