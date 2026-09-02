

export type LangFamily =
  | "clike"
  | "js"
  | "css"
  | "json"
  | "html"
  | "md"
  | "sh"
  | "py"
  | "ruby"
  | "php"
  | "sql"
  | "lua"
  | "perl"
  | "r"
  | "haskell"
  | "lisp"
  | "erlang"
  | "fortran"
  | "yaml"
  | "toml"
  | "ini"
  | "diff"
  | "generic";

const EXT_FAMILY: Record<string, LangFamily> = {
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "js",
  ts: "js",
  mts: "js",
  cts: "js",
  tsx: "js",
  vue: "html",
  svelte: "html",
  astro: "html",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  styl: "css",
  stylus: "css",
  html: "html",
  htm: "html",
  xhtml: "html",
  xml: "html",
  xsl: "html",
  xslt: "html",
  svg: "html",
  jsp: "html",
  asp: "html",
  aspx: "html",
  json: "json",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  ndjson: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini",
  properties: "ini",
  md: "md",
  mdx: "md",
  markdown: "md",
  rst: "md",
  txt: "generic",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  fish: "sh",
  ksh: "sh",
  csh: "sh",
  tcsh: "sh",
  ps1: "sh",
  psm1: "sh",
  bat: "sh",
  cmd: "sh",
  py: "py",
  pyw: "py",
  pyi: "py",
  pyx: "py",
  pxd: "py",
  ipynb: "json",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  php: "php",
  phtml: "php",
  go: "clike",
  rs: "clike",
  c: "clike",
  h: "clike",
  cc: "clike",
  cpp: "clike",
  cxx: "clike",
  hpp: "clike",
  hxx: "clike",
  hh: "clike",
  m: "clike",
  mm: "clike",
  cs: "clike",
  java: "clike",
  kt: "clike",
  kts: "clike",
  scala: "clike",
  sc: "clike",
  groovy: "clike",
  gradle: "clike",
  swift: "clike",
  dart: "clike",
  clj: "lisp",
  cljs: "lisp",
  cljc: "lisp",
  edn: "lisp",
  lisp: "lisp",
  el: "lisp",
  scm: "lisp",
  ss: "lisp",
  racket: "lisp",
  hs: "haskell",
  lhs: "haskell",
  elm: "haskell",
  ml: "clike",
  mli: "clike",
  fs: "clike",
  fsi: "clike",
  fsx: "clike",
  erl: "erlang",
  hrl: "erlang",
  ex: "ruby",
  exs: "ruby",
  pl: "perl",
  pm: "perl",
  t: "perl",
  lua: "lua",
  r: "r",
  R: "r",
  jl: "py",
  zig: "clike",
  nim: "py",
  v: "clike",
  d: "clike",
  pas: "clike",
  pp: "clike",
  sql: "sql",
  mysql: "sql",
  pgsql: "sql",
  psql: "sql",
  hql: "sql",
  graphql: "js",
  gql: "js",
  prisma: "js",
  dockerfile: "sh",
  tf: "clike",
  hcl: "clike",
  nix: "clike",
  makefile: "sh",
  mk: "sh",
  cmake: "sh",
  diff: "diff",
  patch: "diff",
  proto: "clike",
  thrift: "clike",
  avdl: "clike",
  sol: "clike",
  move: "clike",
  wgsl: "clike",
  glsl: "clike",
  vert: "clike",
  frag: "clike",
  hlsl: "clike",
  metal: "clike",
  asm: "generic",
  s: "generic",
  S: "generic",
  f: "fortran",
  f90: "fortran",
  f95: "fortran",
  for: "fortran",
  cob: "generic",
  cbl: "generic",
  vb: "clike",
  vbs: "generic",
  coffee: "js",
  litcoffee: "js",
  ls: "js",
  purescript: "haskell",
  purs: "haskell",
  res: "clike",
  resi: "clike",
  re: "clike",
  rei: "clike",
  mlapp: "generic",
  mat: "generic",
  sas: "generic",
  sparql: "sql",
  rq: "sql",
  turtle: "generic",
  ttl: "generic",
  nq: "generic",
  wasm: "generic",
  wat: "generic",
  csv: "generic",
  tsv: "generic",
  log: "generic",
  lock: "json",
};

const BASENAME_FAMILY: Record<string, LangFamily> = {
  dockerfile: "sh",
  containerfile: "sh",
  makefile: "sh",
  gnumakefile: "sh",
  "cmakelists.txt": "sh",
  "cargo.toml": "toml",
  "pyproject.toml": "toml",
  "package.json": "json",
  "tsconfig.json": "json",
  "jsconfig.json": "json",
  "composer.json": "json",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  brewfile: "ruby",
  vagrantfile: "ruby",
  procfile: "sh",
  justfile: "sh",
  "go.mod": "clike",
  "go.sum": "generic",
  ".gitignore": "ini",
  ".dockerignore": "ini",
  ".npmrc": "ini",
  ".env": "ini",
  ".env.local": "ini",
  ".env.development": "ini",
  ".env.production": "ini",
  ".eslintrc": "json",
  ".prettierrc": "json",
  ".babelrc": "json",
};

export function languageFromPath(path: string): LangFamily {
  const base = (path.split(/[/\\]/).pop() ?? path).toLowerCase();
  if (BASENAME_FAMILY[base]) return BASENAME_FAMILY[base]!;
  for (const [name, fam] of Object.entries(BASENAME_FAMILY)) {
    if (base === name || base.endsWith(name)) return fam;
  }
  const dot = base.lastIndexOf(".");
  if (dot < 0) {
    return "generic";
  }
  const ext = base.slice(dot + 1);
  if (base.endsWith(".d.ts") || base.endsWith(".d.mts") || base.endsWith(".d.cts")) {
    return "js";
  }
  if (base.endsWith(".test.ts") || base.endsWith(".spec.ts") || base.endsWith(".test.tsx")) {
    return "js";
  }
  return EXT_FAMILY[ext] ?? "generic";
}

export function supportedExtensions(): string[] {
  return Object.keys(EXT_FAMILY).sort();
}
