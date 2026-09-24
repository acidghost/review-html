// File drops expose only basenames; served plans carry the absolute path in ?plan=.

export function shorten(path: string) {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, "~");
}

export function elide(s: string, max = 64) {
  return s.length <= max ? s : `${s.slice(0, 14)}…${s.slice(-(max - 15))}`;
}
