import { runGitText } from './runner.js';

/**
 * 两个提交之间的领先 / 落后计数。
 *
 * 分支列表与 upstream 修复方案原先各写了一份，连 `Number.isInteger` 的校验和
 * `catch` 降级都逐字相同；合成一处后只有一处格式约定要维护。
 *
 * 读不到时返回 `null` 而不是抛错：调用方都是展示用途，一个坏掉的 upstream
 * 不该让整个分支列表失败。
 */
export async function commitDivergence(
  cwd: string,
  left: string,
  right: string,
): Promise<{ ahead: number | null; behind: number | null }> {
  try {
    const output = await runGitText(cwd, ['rev-list', '--left-right', '--count', `${left}...${right}`]);
    const [ahead, behind] = output.split(/\s+/).map(Number);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw new Error('提交差异数据无效');
    return { ahead: ahead ?? null, behind: behind ?? null };
  } catch {
    return { ahead: null, behind: null };
  }
}
