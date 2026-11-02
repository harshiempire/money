export const personKey = (name: string) => name.trim().toLowerCase();
export function closePersonNames(names: readonly string[], said: string): string[] {
  const key = personKey(said);
  return [...new Set(names.filter(name => personKey(name).includes(key) || key.includes(personKey(name))))];
}
