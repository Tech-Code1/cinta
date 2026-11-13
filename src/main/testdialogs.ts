// Native dialogs can't be clicked by the self-test, so in --selftest mode the main process uses this stand-in:
// the test queues the answers (files picked, button chosen) and every dialog records what it asked.
import { dialog } from 'electron';

type OpenResult = { canceled: boolean; filePaths: string[] };
type SaveResult = { canceled: boolean; filePath?: string };

export const answers = {
  open: [] as (string[] | null)[],
  save: [] as (string | null)[],
  message: [] as number[],
};
export const asked: string[] = [];

export const testDialog = {
  async showOpenDialog(_w: unknown, o: { title?: string }): Promise<OpenResult> {
    asked.push(`open:${o.title ?? ''}`);
    const a = answers.open.shift();
    return a ? { canceled: false, filePaths: a } : { canceled: true, filePaths: [] };
  },
  async showSaveDialog(_w: unknown, o: { title?: string }): Promise<SaveResult> {
    asked.push(`save:${o.title ?? ''}`);
    const a = answers.save.shift();
    return a ? { canceled: false, filePath: a } : { canceled: true };
  },
  async showMessageBox(_w: unknown, o: { message?: string; defaultId?: number }): Promise<{ response: number }> {
    asked.push(`message:${o.message ?? ''}`);
    return { response: answers.message.length ? answers.message.shift()! : (o.defaultId ?? 0) };
  },
  showErrorBox(title: string, content: string) {
    asked.push(`error:${title}:${content}`);
  },
};

export const pickDialog = (selftest: boolean) => (selftest ? (testDialog as unknown as typeof dialog) : dialog);
