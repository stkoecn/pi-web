export interface TargetCompletionItem {
  target: string; // e.g. "coder@pi-web.wshome" or "sess123.wshome"
  label: string; // display title / name
  description: string; // target address tag e.g. "短ID@项目名.主机名"
  displayTag?: string; // friendly tag e.g. "短ID@项目名.主机名"
  isNewSession: boolean;
  deviceId: string;
  projectName: string;
  sessionName?: string;
}

export function extractTargetQuery(textBeforeCursor: string): { start: number; query: string } | null {
  // Matches line starting with '>' or preceded by whitespace '>...'
  const match = /(?:^|\s)>([^\s]*)$/.exec(textBeforeCursor);
  if (!match) return null;
  return {
    start: textBeforeCursor.length - (match[1].length + 1),
    query: match[1],
  };
}
