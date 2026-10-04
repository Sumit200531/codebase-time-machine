const integer = new Intl.NumberFormat("en-US");
const dateFormat = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "2-digit", timeZone: "UTC" });

export const formatNumber = (value: number): string => integer.format(value);
export const formatDate = (iso: string): string => dateFormat.format(new Date(iso));
export const shortId = (id: string): string => id.slice(0, 7);
export const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
export const signed = (value: number): string => (value > 0 ? `+${formatNumber(value)}` : formatNumber(value));
