/**
 * 公开仓库地址。
 *
 * 客户端顶栏的 GitHub 入口与服务端的「检查更新」都从这里取，避免两处各写一份
 * 地址后慢慢漂开（改仓库名时只改这里）。Gitee 是内部镜像源，不对外暴露。
 */
export const repositoryUrl = 'https://github.com/charsen/moo-git-fleet';
export const releasesUrl = `${repositoryUrl}/releases`;
/** GitHub 的「最新发布」页面：会对最新 tag 回 302，跳转地址里就带着版本号。 */
export const latestReleaseUrl = `${releasesUrl}/latest`;
