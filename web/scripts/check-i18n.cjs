const fs = require('fs')
const ts = require('typescript')

function flatten(o, p = '') {
  let r = []
  for (const k in o) {
    const v = o[k]
    const key = p ? p + '.' + k : k
    if (v && typeof v === 'object') r = r.concat(flatten(v, key))
    else r.push(key)
  }
  return r
}

function load(lang, chunk) {
  const src = fs.readFileSync(`src/i18n/locales/${lang}/${chunk}.ts`, 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require)
  return flatten(mod.exports.default)
}

let ok = true
for (const c of ['shell', 'profile', 'arena', 'chat', 'chain', 'game']) {
  const zh = load('zh', c)
  const en = load('en', c)
  const missingEn = zh.filter((k) => !en.includes(k))
  const missingZh = en.filter((k) => !zh.includes(k))
  const bad = missingEn.length || missingZh.length
  console.log(`${c}: zh=${zh.length} en=${en.length}${bad ? ` MISMATCH en-missing:[${missingEn}] zh-missing:[${missingZh}]` : ' OK'}`)
  if (bad) ok = false
}
process.exit(ok ? 0 : 1)
