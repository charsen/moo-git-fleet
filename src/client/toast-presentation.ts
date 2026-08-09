export type GlobalToastTone = 'success' | 'warning' | 'error';

export type GlobalToastPresentation = {
  tone: GlobalToastTone;
  text: string;
  duration: number;
};

const warningPrefixPattern = /^(?:⚠\uFE0F?\s*)+/u;

export function presentGlobalToast(actionError: string, actionMessage: string): GlobalToastPresentation {
  const tone: GlobalToastTone = actionError
    ? 'error'
    : warningPrefixPattern.test(actionMessage)
      ? 'warning'
      : 'success';
  const rawText = actionError || actionMessage;

  return {
    tone,
    text: rawText.replace(warningPrefixPattern, '').trimStart(),
    duration: tone === 'error' ? 9_000 : tone === 'warning' ? 6_500 : 4_200,
  };
}
