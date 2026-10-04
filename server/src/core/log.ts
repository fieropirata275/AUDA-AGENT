const ts = () => new Date().toISOString().slice(11, 23);
export const log = {
  info: (msg: string, ...rest: unknown[]) => console.log(`${ts()}  ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`${ts()} ! ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) => console.error(`${ts()} ✕ ${msg}`, ...rest),
};
