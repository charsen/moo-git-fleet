<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  AlertTriangle,
  ArrowLeftRight,
  CircleCheck,
  Download,
  FileJson,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  Palette,
  Upload,
} from 'lucide-vue-next';
import {
  configurationExportKind,
  type ConfigurationAppearance,
  type ConfigurationExport,
  type ConfigurationImportCandidate,
  type ConfigurationImportPreview,
  type ConfigurationImportResult,
  type ConfigurationImportStatus,
} from '../../shared/contracts';
import { api } from '../api';
import { hasNativeShell } from '../native-shell';
import {
  codeFontOptions,
  interfaceFontOptions,
  themeOptions,
} from '../appearance';
import { rootNameFromPath } from '../root-identity';
import type { SelectMenuOption } from '../select-options';
import SelectMenu from './SelectMenu.vue';

/**
 * 跨机配置迁移（设置 → 配置迁移）。
 *
 * 场景：三台电脑来回开发，某台机器上新建的项目在另一台上不存在。这里的做法是
 * 「导出清单 → 另一台选目录 → 预览分类 → 勾选后逐条克隆并登记」，界面主题与
 * DeepSeek Key 跟着同一个文件走，但**应用设置**是独立勾选项——它是整条流程里
 * 唯一会覆盖本机已有偏好的动作。
 *
 * 三条边界：
 * 1. **仓库只增不删**——导入只会 clone 与写配置，不会改动目标目录里已有的内容；
 *    目录被占用一律判冲突，不提供「先删再克隆」。
 * 2. **逐条执行**——克隆大仓库可能要几分钟，整批塞进一个请求必然撞超时，
 *    所以这里按条调用，进度与失败原因都能逐条看到。
 * 3. **Key 不出现在界面上**——服务端只回「有没有 / 会不会覆盖」，回显一律不给。
 *
 * 文件往返在原生外壳里换了一条路：WKWebView 既打不开 `<input type="file">`
 * （`runOpenPanelWith` 没实现），也不落地 `<a download>` 的 blob（download 分支没实现，
 * 且**不报错**）。所以 shell 里改成「服务端写文件 / 服务端弹系统对话框」，
 * 浏览器里仍走原来的浏览器通道。
 */
const props = defineProps<{ roots: Record<string, string>; repositoryCount: number }>();
const emit = defineEmits<{ 'roots-changed': []; imported: []; 'settings-applied': [appearance: ConfigurationAppearance] }>();

/** 设置这一条在结果列表里的伪 key，与仓库条目共用一套展示。 */
const settingsResultKey = '__settings__';

/** WKWebView 里浏览器文件通道不可用，见文件头。构建期就能定下来，不必做成响应式。 */
const nativeShell = hasNativeShell();

const fileInput = ref<HTMLInputElement | null>(null);
const fileName = ref('');
const payload = ref<ConfigurationExport | null>(null);
const exportBusy = ref(false);
/** 系统文件对话框可能开着几分钟，按钮要有「在等」的状态，否则用户会反复点。 */
const filePicking = ref(false);
const rootBusy = ref(false);
const rootId = ref('');
const preview = ref<ConfigurationImportPreview | null>(null);
const previewLoading = ref(false);
const previewError = ref('');
const selected = ref<Set<string>>(new Set());
const applySettings = ref(true);
/**
 * 已应用过的那份外观的签名：应用完再点一次「应用设置」是空动作，干脆把卡片收起来。
 *
 * 用签名字符串而不是直接比对象：`JSON.stringify` 的键序依赖服务端 schema 的字段顺序，
 * 哪天 schema 顺序调了，这里会莫名其妙地「应用过了还显示待应用」。
 */
const appliedAppearance = ref('');
/**
 * 这份文件里的 Key 是否已经处理过（写过或确认一致）。
 *
 * 不能只看 `apiKeyState`：目标机用 `GIT_FLEET_AI_API_KEY` 跑时，写进文件也读不到它，
 * 预览会永远说「将覆盖」，按钮就会一直亮着、点一次失败一次。
 */
const appliedKey = ref(false);
const busy = ref(false);
const progress = ref<{ done: number; total: number; current: string } | null>(null);
const results = ref<ConfigurationImportResult[]>([]);
const notice = ref<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

const rootOptions = computed<SelectMenuOption[]>(() =>
  Object.entries(props.roots).map(([id, rootPath]) => ({
    value: id,
    label: rootNameFromPath(rootPath),
    hint: rootPath,
    keywords: rootPath,
  })),
);

const rootPath = computed(() => props.roots[rootId.value] ?? '');

/** 根目录列表异步到达（首屏是空对象），拿到后就选第一个，否则预览按钮永远是灰的。 */
watch(
  () => props.roots,
  (roots) => {
    if (!rootId.value || !roots[rootId.value]) rootId.value = Object.keys(roots)[0] ?? '';
  },
  { immediate: true, deep: true },
);

watch(rootPath, () => {
  if (payload.value) void refreshPreview();
});

const statusLabels: Record<ConfigurationImportStatus, string> = {
  existing: '已在工作台',
  link: '只需登记',
  clone: '将克隆',
  'no-remote': '无法重建',
  conflict: '冲突',
};

const selectedCount = computed(() => selected.value.size);
const selectableCount = computed(
  () => preview.value?.candidates.filter((candidate) => isSelectable(candidate)).length ?? 0,
);
/** 结果列表混着「设置」一条，统计仓库数量时要把那条摘出去。 */
const repoResults = computed(() => results.value.filter((item) => item.key !== settingsResultKey));
const failureCount = computed(() => results.value.filter((item) => item.status === 'failed').length);
const successCount = computed(() => repoResults.value.filter((item) => item.status !== 'failed').length);

/** 导出包里到底有没有可应用的设置（旧版导出没有这两块，勾选项就不出现）。 */
const settingsPending = computed(() => {
  const settings = preview.value?.settings;
  if (!settings) return false;
  const appearancePending = Boolean(settings.appearance)
    && appearanceSignature(settings.appearance) !== appliedAppearance.value;
  const keyPending = !appliedKey.value
    && (settings.apiKeyState === 'new' || settings.apiKeyState === 'overwrite');
  return appearancePending || keyPending;
});
const settingsApplies = computed(() => settingsPending.value && applySettings.value);
const footerDisabled = computed(() => busy.value || (!selectedCount.value && !settingsApplies.value));
const footerLabel = computed(() => {
  if (busy.value) return '正在导入…';
  if (selectedCount.value) return `导入选中 ${selectedCount.value} 个`;
  return settingsApplies.value ? '应用设置' : '导入配置';
});

const appearanceSummary = computed(() => {
  const appearance = preview.value?.settings.appearance;
  if (!appearance) return '';
  const themeLabel = themeOptions.find((option) => option.value === appearance.theme)?.label ?? appearance.theme;
  const fontLabel = appearance.interfaceFont
    ? interfaceFontOptions.find((option) => option.value === appearance.interfaceFont)?.label ?? appearance.interfaceFont
    : '默认字体';
  const sizeLabel = appearance.interfaceFontSize ? `${appearance.interfaceFontSize}px` : '默认字号';
  const codeLabel = appearance.codeFont
    ? codeFontOptions.find((option) => option.value === appearance.codeFont)?.label ?? appearance.codeFont
    : '';
  const codeSize = appearance.codeFontSize ? ` · ${appearance.codeFontSize}px` : '';
  return [
    `主题 ${themeLabel}`,
    `界面 ${fontLabel} · ${sizeLabel}`,
    codeLabel ? `代码 ${codeLabel}${codeSize}` : '',
  ].filter(Boolean).join(' · ');
});

const apiKeyLabel = computed(() => {
  switch (preview.value?.settings.apiKeyState) {
    case 'new':
      return '将写入本机（本机尚未配置）';
    case 'same':
      return '与本机一致，不会重写';
    case 'overwrite':
      return '将覆盖本机已有的 Key';
    default:
      return '导出包里没有 Key';
  }
});

function isSelectable(candidate: ConfigurationImportCandidate): boolean {
  return candidate.status === 'clone' || candidate.status === 'link';
}

/** 外观的稳定签名：只看值，不看对象键序。 */
function appearanceSignature(appearance: ConfigurationAppearance | null): string {
  if (!appearance) return '';
  return [
    appearance.theme,
    appearance.interfaceFont ?? '',
    appearance.interfaceFontSize ?? '',
    appearance.codeFont ?? '',
    appearance.codeFontSize ?? '',
  ].join('|');
}

function toggle(key: string): void {
  const next = new Set(selected.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selected.value = next;
}

function selectAll(): void {
  selected.value = new Set(
    (preview.value?.candidates ?? []).filter((candidate) => isSelectable(candidate)).map((candidate) => candidate.key),
  );
}

function clearSelection(): void {
  selected.value = new Set();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

function isConfigurationExport(value: unknown): value is ConfigurationExport {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ConfigurationExport>;
  return candidate.kind === configurationExportKind
    && candidate.version === 1
    && Array.isArray(candidate.repositories);
}

function downloadName(data: ConfigurationExport): string {
  const machine = (data.machine || 'machine').replace(/[^\w.-]+/g, '-');
  const day = data.exportedAt.slice(0, 10) || new Date().toISOString().slice(0, 10);
  return `moo-fleet-config-${machine}-${day}.json`;
}

async function exportConfiguration(): Promise<void> {
  if (exportBusy.value) return;
  exportBusy.value = true;
  notice.value = null;
  try {
    if (nativeShell) {
      // 原生外壳：让服务端落盘。这里必须等真实结果，不能再「点完就报成功」——
      // WKWebView 对 blob 下载是静默无效的，假成功会让用户拿着空下载目录去换机器。
      const written = await api.exportConfigurationToFile();
      const extras = [written.includesAppearance ? '界面设置' : '', written.includesApiKey ? 'DeepSeek Key' : '']
        .filter(Boolean);
      notice.value = {
        tone: 'ok',
        text: `已导出 ${written.repositories} 个仓库配置到 ${written.path}${extras.length ? `（含${extras.join('、')}）` : ''}`,
      };
      return;
    }
    const data = await api.exportConfiguration();
    const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadName(data);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // 立刻 revoke 会让部分浏览器拿到空文件，等这一拍过去再释放。
    setTimeout(() => URL.revokeObjectURL(url), 0);
    const extras = [data.appearance ? '界面设置' : '', data.ai?.apiKey ? 'DeepSeek Key' : ''].filter(Boolean);
    notice.value = {
      tone: 'ok',
      text: `已导出 ${data.repositories.length} 个仓库配置${extras.length ? `，含${extras.join('、')}` : ''}`,
    };
  } catch (error) {
    notice.value = { tone: 'error', text: messageOf(error) };
  } finally {
    exportBusy.value = false;
  }
}

/**
 * 「选择配置文件…」：原生外壳走系统对话框，浏览器走隐藏的 file input。
 *
 * 对话框是模态的，用户可能几分钟后才动它，所以整段期间按钮保持禁用态。
 */
async function chooseConfigFile(): Promise<void> {
  if (busy.value || filePicking.value) return;
  if (!nativeShell) {
    fileInput.value?.click();
    return;
  }
  filePicking.value = true;
  notice.value = null;
  try {
    const picked = await api.pickConfigurationFile();
    // 取消：什么都不做，也不要清掉上一次已经加载好的预览。
    if (!picked) return;
    await acceptPayload(picked.payload, picked.fileName);
  } catch (error) {
    notice.value = { tone: 'error', text: messageOf(error) };
  } finally {
    filePicking.value = false;
  }
}

/** 两路入口（系统对话框 / 浏览器 file input）共用：装载一份已解析的配置并重算预览。 */
async function acceptPayload(parsed: ConfigurationExport, name: string): Promise<void> {
  payload.value = parsed;
  fileName.value = name;
  // 每换一份文件都回到「应用设置」的默认勾选：这是最常见的一次性迁移动作。
  applySettings.value = true;
  appliedAppearance.value = '';
  appliedKey.value = false;
  results.value = [];
  await refreshPreview();
}

async function onFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 清空以便再次选择同一个文件时仍触发 change。
  input.value = '';
  if (!file) return;
  notice.value = null;
  results.value = [];
  if (file.size > 2 * 1024 * 1024) {
    notice.value = { tone: 'error', text: '配置文件超过 2 MB，已拒绝读取' };
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    notice.value = { tone: 'error', text: '这个文件不是合法的 JSON' };
    return;
  }
  if (!isConfigurationExport(parsed)) {
    notice.value = { tone: 'error', text: '这不是 Moo Fleet 导出的配置文件（缺少 kind / version / repositories）' };
    return;
  }
  await acceptPayload(parsed, file.name);
}

async function refreshPreview(): Promise<void> {
  const current = payload.value;
  if (!current || !rootId.value) {
    preview.value = null;
    selected.value = new Set();
    return;
  }
  previewLoading.value = true;
  previewError.value = '';
  try {
    const result = await api.previewConfigurationImport(current, rootId.value);
    preview.value = result;
    selected.value = new Set(result.candidates.filter((candidate) => isSelectable(candidate)).map((candidate) => candidate.key));
  } catch (error) {
    preview.value = null;
    selected.value = new Set();
    previewError.value = messageOf(error);
  } finally {
    previewLoading.value = false;
  }
}

async function chooseRoot(): Promise<void> {
  if (rootBusy.value) return;
  rootBusy.value = true;
  notice.value = null;
  try {
    const picked = await api.selectDirectory(rootPath.value || undefined);
    const chosen = picked.path;
    if (!chosen) return;
    const existing = Object.entries(props.roots).find(([, configured]) => configured === chosen);
    if (existing) {
      rootId.value = existing[0];
      return;
    }
    const added = await api.addRoot(chosen);
    // 新根目录要等上层刷新 `roots` 才会出现在下拉里；先切过去，watch 会带着预览重算。
    emit('roots-changed');
    await nextTick();
    rootId.value = added.rootId;
    notice.value = { tone: 'ok', text: `已加入根目录：${chosen}` };
  } catch (error) {
    notice.value = { tone: 'error', text: messageOf(error) };
  } finally {
    rootBusy.value = false;
  }
}

async function runImport(): Promise<void> {
  const current = payload.value;
  const currentPreview = preview.value;
  if (!current || !currentPreview || busy.value) return;
  const keys = currentPreview.candidates
    .filter((candidate) => selected.value.has(candidate.key))
    .map((candidate) => candidate.key);
  const withSettings = settingsApplies.value;
  if (!keys.length && !withSettings) return;
  const names = new Map(currentPreview.candidates.map((candidate) => [candidate.key, candidate.name]));

  busy.value = true;
  notice.value = null;
  results.value = [];
  const totalSteps = keys.length + (withSettings ? 1 : 0);
  let step = 0;
  /** 设置应用成功但有前提未满足（如 Key 被环境变量覆盖）：收尾时要如实提一句。 */
  let settingsNote = '';
  progress.value = {
    done: 0,
    total: totalSteps,
    current: withSettings ? '界面与 AI 设置' : (names.get(keys[0] ?? '') ?? ''),
  };
  try {
    // 设置先做：它是一条快请求，而且失败也不该拖住后面的克隆。
    if (withSettings) {
      try {
        const applied = await api.applyConfigurationSettings(current);
        results.value = [
          {
            key: settingsResultKey,
            name: '界面与 AI 设置',
            status: 'applied',
            message: applied.message,
            repositoryId: null,
          },
        ];
        if (applied.appearance) emit('settings-applied', applied.appearance);
        // 记下已经应用过的那一份：预览刷新后卡片会自己收起，不会留一个空按钮。
        appliedAppearance.value = appearanceSignature(applied.appearance ?? null);
        appliedKey.value = true;
        if (!applied.apiKeyEffective) {
          settingsNote = 'Key 已写入文件，但当前进程由 GIT_FLEET_AI_API_KEY 提供，实际生效的仍是环境变量';
        }
      } catch (error) {
        results.value = [
          {
            key: settingsResultKey,
            name: '界面与 AI 设置',
            status: 'failed',
            message: messageOf(error),
            repositoryId: null,
          },
        ];
      }
      step += 1;
      // 只勾了设置、没选仓库时不会有下面的循环，进度要在这里推一格。
      progress.value = { done: step, total: totalSteps, current: '界面与 AI 设置' };
    }

    for (const key of keys) {
      const name = names.get(key) ?? '';
      progress.value = { done: step, total: totalSteps, current: name };
      try {
        const result = await api.importConfigurationEntry(current, rootId.value, key);
        results.value = [...results.value, result];
      } catch (error) {
        // 单条失败不中断整轮：其余仓库照样导，失败原因逐条留在结果里。
        results.value = [...results.value, { key, name, status: 'failed', message: messageOf(error), repositoryId: null }];
      }
      step += 1;
      progress.value = { done: step, total: totalSteps, current: name };
    }
  } finally {
    busy.value = false;
    progress.value = null;
    selected.value = new Set();
    emit('imported');
    await refreshPreview();
    let tone: 'ok' | 'warn' = 'ok';
    let text: string;
    if (failureCount.value) {
      tone = 'warn';
      text = successCount.value
        ? `${successCount.value} 个仓库已加入，${failureCount.value} 项失败`
        : `${failureCount.value} 项失败`;
    } else if (successCount.value) {
      text = `${successCount.value} 个仓库已加入工作台`;
    } else {
      text = '设置已应用到本机';
    }
    if (settingsNote) {
      tone = 'warn';
      text = `${text}；${settingsNote}`;
    }
    notice.value = { tone, text };
  }
}

const resultLabel: Record<ConfigurationImportResult['status'], string> = {
  cloned: '已克隆',
  linked: '已登记',
  existing: '已存在',
  applied: '已应用',
  failed: '失败',
};
</script>

<template>
  <div class="manage-pane-heading">
    <span class="manage-pane-icon"><ArrowLeftRight :size="17" /></span>
    <div>
      <strong>配置迁移</strong>
      <small>把仓库清单从一台电脑搬到另一台：身份、分组、远端地址，外加界面主题与 DeepSeek Key</small>
    </div>
  </div>

  <section class="transfer-block">
    <div class="transfer-block-head">
      <div>
        <strong>导出当前配置</strong>
        <small>{{ repositoryCount }} 个仓库 · 远端地址、界面主题与 DeepSeek Key 一起带走</small>
      </div>
      <button type="button" class="secondary-button" :disabled="exportBusy" @click="exportConfiguration">
        <LoaderCircle v-if="exportBusy" :size="15" class="spinning" />
        <Download v-else :size="15" />导出配置文件
      </button>
    </div>
    <p class="transfer-note transfer-secret">
      <AlertTriangle :size="13" aria-hidden="true" />
      含 DeepSeek Key 明文；文件只用于自己的另一台电脑，请勿上传到公开仓库或云盘。git 凭证、会话内容不在其中，远端地址里的账号密码也会被剥掉。
    </p>
    <p v-if="nativeShell" class="transfer-note">
      文件会写进这台电脑的下载目录，导出成功后显示完整路径。
    </p>
  </section>

  <section class="transfer-block">
    <div class="transfer-block-head">
      <div>
        <strong>从另一台电脑导入</strong>
        <small>选好目标目录后，本地没有的仓库会从远端克隆</small>
      </div>
      <button
        type="button"
        class="secondary-button"
        :class="{ 'transfer-picking': filePicking }"
        :disabled="busy || filePicking"
        @click="chooseConfigFile"
      >
        <LoaderCircle v-if="filePicking" :size="15" class="spinning" />
        <FileJson v-else :size="15" />{{ filePicking ? '等待选择…' : '选择配置文件…' }}
      </button>
    </div>
    <input
      v-if="!nativeShell"
      ref="fileInput"
      class="transfer-file-input"
      type="file"
      accept="application/json,.json"
      aria-label="选择配置文件"
      @change="onFileChosen"
    />
    <p v-if="!fileName" class="transfer-note">{{ nativeShell ? '会弹出系统文件对话框，不会执行文件里的任何内容。' : '读取的是 Moo Fleet 导出的 JSON，不会执行文件里的任何内容。' }}</p>
    <p v-else class="transfer-file">
      <FileJson :size="14" aria-hidden="true" />
      <strong>{{ fileName }}</strong>
      <span>{{ payload?.repositories.length ?? 0 }} 个仓库</span>
      <span v-if="payload?.machine">来自 {{ payload.machine }}</span>
    </p>

    <div class="transfer-root-row">
      <label class="form-field">
        <span>导入到哪个目录</span>
        <SelectMenu v-model="rootId" :options="rootOptions" class="select-menu--field" aria-label="导入目标目录" />
      </label>
      <button type="button" class="compact-button" :disabled="rootBusy" @click="chooseRoot">
        <LoaderCircle v-if="rootBusy" :size="13" class="spinning" />
        <FolderOpen v-else :size="13" />选择其他目录…
      </button>
    </div>
    <p v-if="rootPath" class="transfer-note">落点：<code>{{ rootPath }}</code></p>
  </section>

  <!-- 设置是整条流程里唯一会覆盖本机已有偏好的动作：独立成一张卡，必须显式勾选。 -->
  <section v-if="preview && settingsPending && !previewLoading" class="transfer-block transfer-settings">
    <label class="transfer-settings-check">
      <input v-model="applySettings" type="checkbox" :disabled="busy" />
      <span class="transfer-settings-copy">
        <strong>同时应用界面与 AI 设置</strong>
        <small v-if="appearanceSummary"><Palette :size="12" aria-hidden="true" />{{ appearanceSummary }}</small>
        <small><KeyRound :size="12" aria-hidden="true" />DeepSeek Key：{{ apiKeyLabel }}</small>
      </span>
    </label>
    <p v-if="applySettings" class="transfer-note transfer-secret">
      <AlertTriangle :size="13" aria-hidden="true" />会覆盖本机当前的主题、字体与 Key；仓库导入本身不会改动任何已有目录。
    </p>
  </section>

  <p v-if="notice" class="transfer-notice" :data-tone="notice.tone" role="status">{{ notice.text }}</p>

  <!-- 逐条结果放在预览列表之前：导入完成后列表会整片变成「已在工作台」，
       把结果留在最底部就等于用户看不到哪一条失败了。 -->
  <ul v-if="results.length" class="transfer-results">
    <li v-for="item in results" :key="item.key" :data-status="item.status">
      <CircleCheck v-if="item.status !== 'failed'" :size="13" aria-hidden="true" />
      <AlertTriangle v-else :size="13" aria-hidden="true" />
      <strong>{{ resultLabel[item.status] }}</strong>
      <span>{{ item.name }}</span>
      <small>{{ item.message }}</small>
    </li>
  </ul>

  <p v-if="previewLoading" class="transfer-state" role="status"><LoaderCircle :size="14" class="spinning" />正在检查目标目录…</p>
  <p v-else-if="previewError" class="transfer-state" data-tone="error" role="alert"><AlertTriangle :size="14" />{{ previewError }}</p>

  <template v-else-if="preview">
    <div class="transfer-summary">
      <span><b>{{ preview.total }}</b> 个仓库</span>
      <span data-status="clone">将克隆 {{ preview.counts.clone }}</span>
      <span data-status="link">只需登记 {{ preview.counts.link }}</span>
      <span data-status="existing">已在工作台 {{ preview.counts.existing }}</span>
      <span v-if="preview.counts.noRemote" data-status="no-remote">无法重建 {{ preview.counts.noRemote }}</span>
      <span v-if="preview.counts.conflict" data-status="conflict">冲突 {{ preview.counts.conflict }}</span>
      <span class="transfer-summary-actions">
        <button type="button" class="transfer-link-button" :disabled="busy || !selectableCount" @click="selectAll">全选</button>
        <button type="button" class="transfer-link-button" :disabled="busy || !selectedCount" @click="clearSelection">清空</button>
      </span>
    </div>

    <ul class="transfer-list">
      <li v-for="candidate in preview.candidates" :key="candidate.key" class="transfer-row" :data-status="candidate.status">
        <label class="transfer-row-check">
          <input
            type="checkbox"
            :checked="selected.has(candidate.key)"
            :disabled="busy || !isSelectable(candidate)"
            :aria-label="`导入 ${candidate.name}`"
            @change="toggle(candidate.key)"
          />
        </label>
        <span class="transfer-row-name">
          <strong>{{ candidate.name }}</strong>
          <small>{{ candidate.group }}<template v-if="candidate.remote"> · {{ candidate.remote }}</template></small>
        </span>
        <span class="transfer-badge" :data-status="candidate.status">{{ statusLabels[candidate.status] }}</span>
        <span class="transfer-row-detail">{{ candidate.detail }}</span>
      </li>
    </ul>

    <div class="transfer-footer">
      <span class="transfer-progress" role="status">
        <template v-if="progress">
          <LoaderCircle :size="14" class="spinning" />{{ progress.done }}/{{ progress.total }}<template v-if="progress.current"> · {{ progress.current }}</template>
        </template>
        <template v-else>
          已选 {{ selectedCount }} 个<template v-if="settingsApplies"> · 带设置</template>
        </template>
      </span>
      <button type="button" class="primary-button" :disabled="footerDisabled" @click="runImport">
        <LoaderCircle v-if="busy" :size="14" class="spinning" />
        <Upload v-else :size="14" />{{ footerLabel }}
      </button>
    </div>
  </template>
</template>

<style scoped>
.transfer-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  background: var(--color-card);
}
.transfer-block + .transfer-block { margin-top: 12px; }
/* 对话框开着的时候按钮是 disabled，但那是「在等你」，不是「不可用」：
   默认禁用态太淡，用户会以为按钮坏了，反复点也不会有反应。 */
.secondary-button.transfer-picking:disabled { color: var(--color-text); cursor: progress; }
.secondary-button.transfer-picking:disabled svg { color: var(--color-brand); }
.transfer-block-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.transfer-block-head strong { display: block; color: var(--color-text-strong); font-size: 13px; font-weight: 600; }
.transfer-block-head small { display: block; margin-top: 2px; color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.transfer-file-input { display: none; }
.transfer-note { margin: 0; color: var(--color-text-muted); font-size: 12px; line-height: 1.6; }
.transfer-note code { color: var(--color-text); }
.transfer-secret {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--color-yellow);
}
.transfer-secret svg { flex: 0 0 auto; margin-top: 2px; }
.transfer-settings { border-color: var(--color-border); }
.transfer-settings-check {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  cursor: pointer;
}
.transfer-settings-check input { margin: 2px 0 0; }
.transfer-settings-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.transfer-settings-copy strong { color: var(--color-text-strong); font-size: 13px; font-weight: 600; }
.transfer-settings-copy small {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.5;
}
.transfer-settings-copy small svg { flex: 0 0 auto; }
.transfer-file {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--color-text-muted);
  font-size: 12px;
}
.transfer-file strong { color: var(--color-text); font-weight: 600; }
/* 这一行是「标签 + 控件 + 动作」三段并排：`form-field` 自带 14px 下外边距（全局
   表单节奏），放在 `align-items: flex-end` 的行里会被算进行高，把按钮顶到选择框
   下面 14px 处——看着像按钮掉队了。外边距清零后两者底边才真正对齐。
   按钮高度对齐输入框的 40px（见 styles.css 的 `.form-field input`），否则
   31px 的 compact-button 只贴底、上沿还是错开一截。 */
.transfer-root-row { display: flex; align-items: flex-end; gap: 10px; }
.transfer-root-row .form-field { flex: 1 1 auto; min-width: 0; margin: 0; }
.transfer-root-row .compact-button { flex: 0 0 auto; min-height: 40px; }
.transfer-notice { margin: 12px 0 0; font-size: 12px; line-height: 1.6; color: var(--color-text-muted); }
/* 导出成功的提示里带绝对路径，长路径要能在任意位置折行，否则会顶出容器。 */
.transfer-notice[data-tone='ok'] { color: var(--color-success); overflow-wrap: anywhere; }
.transfer-notice[data-tone='warn'] { color: var(--color-yellow); }
.transfer-notice[data-tone='error'] { color: var(--color-red); }
.transfer-state {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 12px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
}
.transfer-state[data-tone='error'] { color: var(--color-red); }
.transfer-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  /* 14px 是这个面板里唯一一个「和别处不一样」的间距：卡片之间、提示、结果、动作条
     都是 12px。统一到 12px，整列左边缘之外的纵向节奏才只有一档。 */
  margin: 12px 0 8px;
  color: var(--color-text-muted);
  font-size: 12px;
}
.transfer-summary b { color: var(--color-text-strong); }
.transfer-summary span[data-status='clone'] { color: var(--color-brand); }
.transfer-summary span[data-status='no-remote'],
.transfer-summary span[data-status='conflict'] { color: var(--color-yellow); }
.transfer-summary-actions { margin-left: auto; display: flex; gap: 10px; }
.transfer-link-button {
  border: 0;
  padding: 0;
  background: none;
  color: var(--color-brand);
  font: inherit;
  cursor: pointer;
}
.transfer-link-button:disabled { color: var(--color-text-muted); cursor: default; }
.transfer-list {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  background: var(--color-card);
  overflow: hidden;
}
.transfer-row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  grid-template-areas: 'check name badge' 'check detail detail';
  align-items: center;
  gap: 2px 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--color-border-subtle);
}
.transfer-row:last-child { border-bottom: 0; }
.transfer-row-check { grid-area: check; display: flex; align-items: center; }
.transfer-row-name { grid-area: name; display: flex; flex-direction: column; min-width: 0; }
.transfer-row-name strong { color: var(--color-text); font-size: 13px; font-weight: 600; }
.transfer-row-name small {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.transfer-badge {
  grid-area: badge;
  padding: 1px 7px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-muted);
  font-size: 11px;
  white-space: nowrap;
}
.transfer-badge[data-status='clone'] { border-color: var(--color-brand); color: var(--color-brand); }
.transfer-badge[data-status='no-remote'],
.transfer-badge[data-status='conflict'] { border-color: var(--color-yellow); color: var(--color-yellow); }
.transfer-badge[data-status='existing'] { opacity: 0.7; }
.transfer-row-detail { grid-area: detail; color: var(--color-text-muted); font-size: 11px; line-height: 1.5; }
/* 列表可能几十条：动作条贴在滚动容器底部，用户不必先滚到底才能开始导入。 */
.transfer-footer {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding: 10px 0 4px;
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-canvas);
}
.transfer-progress {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-muted);
  font-size: 12px;
}
.transfer-results {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--color-text-muted);
}
.transfer-results li { display: flex; align-items: baseline; gap: 6px; }
.transfer-results li[data-status='failed'] { color: var(--color-red); }
/* 状态与名字不能被长说明挤到换行（「已应/用」这种断字很难看）：让说明独占剩余宽度。 */
.transfer-results strong { flex: 0 0 auto; white-space: nowrap; font-weight: 600; }
.transfer-results span { flex: 0 0 auto; color: var(--color-text); white-space: nowrap; }
.transfer-results small { flex: 1 1 auto; min-width: 0; }
</style>
