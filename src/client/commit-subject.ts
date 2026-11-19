/** 空提交说明（git commit --allow-empty-message）在列表里给一个占位，避免整行没有可读文本。 */
export function displaySubject(subject: string): string {
  return subject.trim() ? subject : '（无提交说明）';
}
