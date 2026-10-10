/**
 * Web lookup for drug information, used when the written notes do not cover a
 * drug. This is the difference between an assistant that says "I don't have
 * notes for melatonin" and one that goes and finds citable answers.
 *
 * Two rules shape this module:
 *
 * 1. **Quote, never paraphrase from memory.** Whatever the model ends up
 *    saying must trace back to a URL that the user can open. A drug fact
 *    recalled from training is exactly the failure mode the local notes exist
 *    to prevent, so the web path returns *passages* with their source and lets
 *    nothing be invented in between.
 * 2. **Prefer sources a pharmacist would accept.** Searches are anchored on
 *    regulator and reference domains, and results from those are ranked above
 *    everything else. A random wellness blog is not a drug reference.
 *
 * Everything here is pure or injected, so the whole path is testable without a
 * network.
 */

/** Domains that count as a drug reference, in rough order of authority. */
export const TRUSTED_SOURCE_HOSTS = [
  'dailymed.nlm.nih.gov',
  'medlineplus.gov',
  'ncbi.nlm.nih.gov',
  'pubmed.ncbi.nlm.nih.gov',
  'pmc.ncbi.nlm.nih.gov',
  'fda.gov',
  'ema.europa.eu',
  'msdmanuals.com',
  'msdmanuals.cn',
  'dayi.org.cn',
  'drugs.dxy.cn',
  'nmpa.gov.cn',
  'who.int',
  'nice.org.uk',
  'gov.uk'
]

/**
 * Sources written in Chinese. A Chinese reader gets far more from these than
 * from a Hungarian EMA annexe: a lookup that returns untranslated foreign
 * regulatory text has technically answered and practically failed.
 */
export const CHINESE_SOURCE_HOSTS = [
  'msdmanuals.cn',
  'dayi.org.cn',
  'drugs.dxy.cn',
  'dxy.cn',
  'medlive.cn',
  'nmpa.gov.cn',
  'nhc.gov.cn',
  'cma.org.cn',
  'chinacdc.cn'
]

/**
 * Authority tiers, best first. Used to break ties that a single boolean
 * "trusted" flag cannot express.
 */
const HOST_TIERS = [
  ['dailymed.nlm.nih.gov', 'medlineplus.gov', 'ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov', 'pmc.ncbi.nlm.nih.gov',
    'fda.gov', 'ema.europa.eu', 'nmpa.gov.cn', 'nhc.gov.cn', 'who.int', 'nice.org.uk', 'gov.uk'],
  ['msdmanuals.cn', 'msdmanuals.com', 'dayi.org.cn', 'drugs.dxy.cn', 'dxy.cn', 'medlive.cn', 'cma.org.cn']
]

/** The Chinese half of each aspect's search terms. */
export const ASPECT_QUERY_TERMS = {
  restrictions: { zh: '禁忌 相互作用 避免', en: 'contraindications interactions avoid' },
  monitoring: { zh: '需要监测 复查 检查', en: 'monitoring laboratory tests' },
  sideEffects: { zh: '不良反应 副作用', en: 'side effects adverse reactions' },
  supportive: { zh: '注意事项 护理 日常', en: 'precautions supportive care' },
  redFlags: { zh: '严重不良反应 就医 警示', en: 'serious warnings seek medical attention' },
  dosing: { zh: '用法用量 说明书', en: 'dosage administration' },
  timing: { zh: '服用时间 睡前 时机', en: 'timing before bed when to take' }
}

/**
 * Which facet of a drug the caller is asking about.
 *
 * The keyword lists are deliberately broad. A narrow list fails silently — the
 * extractor simply returns nothing — and real product information says "就寝前"
 * where a user would say "睡前". Missing a passage costs the user an answer, so
 * each facet carries the vocabulary of both a label and a patient.
 */
export const DRUG_ASPECTS = {
  restrictions: {
    id: 'restrictions',
    label: '忌口与相互作用',
    keywords: ['酒精', '饮酒', '喝酒', '忌', '禁忌', '禁', '相互作用', '避免', '合用', '同服', '饮食', '食物', '忌口',
      'contraindication', 'interaction', 'avoid', 'alcohol', 'food', 'dietary', 'with food', 'empty stomach']
  },
  monitoring: {
    id: 'monitoring',
    label: '需要复查/监测的项目',
    keywords: ['监测', '复查', '检查', '肝功能', '肾功能', '血脂', '血常规', '化验', '指标', '用药期间',
      'monitor', 'laboratory', 'liver', 'renal', 'lipid', 'test', 'blood']
  },
  sideEffects: {
    id: 'sideEffects',
    label: '常见不良反应',
    keywords: ['不良反应', '副作用', '常见', '头痛', '头晕', '恶心', '嗜睡', '皮疹', '口干',
      'side effect', 'adverse', 'common', 'nausea', 'headache', 'dizziness', 'rash']
  },
  supportive: {
    id: 'supportive',
    label: '日常护理',
    keywords: ['补水', '保湿', '护理', '饮水', '多喝水', '润唇', '人工泪液', '加湿',
      'hydrat', 'moistur', 'lip balm', 'eye drop', 'supportive', 'skin care']
  },
  redFlags: {
    id: 'redFlags',
    label: '需要就医的征象',
    keywords: ['就医', '急诊', '立即', '严重', '尽快', '停药', '警示', '罕见',
      'red flag', 'seek medical', 'emergency', 'serious', 'discontinue', 'warning']
  },
  dosing: {
    id: 'dosing',
    label: '剂量与服法',
    keywords: ['剂量', '用法', '用量', '服法', '每日', '口服', '服用', '片',
      'dose', 'dosage', 'administration', 'take', 'mg']
  },
  timing: {
    id: 'timing',
    label: '服用时机',
    keywords: ['时机', '睡前', '就寝', '服用时间', '给药', '提前', '几小时', '半小时', '空腹', '餐前', '餐后', '随餐',
      'timing', 'before bed', 'bedtime', 'hours before', 'interval', 'with meals']
  }
}

/** How many characters of page text to keep for scoring; bounds memory. */
const MAX_PAGE_CHARS = 60000
/** How many passages to return per lookup. */
const MAX_PASSAGES = 6
/**
 * Minimum passage length worth showing, per writing system.
 *
 * A single cutoff cannot serve both: forty Latin characters is half a sentence,
 * while forty Chinese characters is a whole paragraph. Using the Latin number
 * for Chinese silently discarded almost every useful passage, which is the
 * worst possible bug in this module — it fails by finding nothing.
 */
const MIN_PASSAGE_CHARS_CJK = 12
const MIN_PASSAGE_CHARS_LATIN = 40

/** Share of characters in the CJK ranges, used to pick a length threshold. */
export function cjkRatio(text) {
  const sample = String(text ?? '').slice(0, 4000)
  if (sample.length === 0) return 0
  const cjk = sample.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)
  return (cjk?.length ?? 0) / sample.length
}

/** The length below which a passage is treated as noise. */
export function minPassageLength(text) {
  return cjkRatio(text) >= 0.15 ? MIN_PASSAGE_CHARS_CJK : MIN_PASSAGE_CHARS_LATIN
}

/**
 * Turn a fragment of HTML into readable text.
 *
 * Deliberately crude: it only has to be good enough to quote from, and a
 * dependency-free regex pass keeps the plugin's dependency surface at one
 * package instead of pulling in an HTML parser.
 *
 * @param {string} html
 */
export function htmlToText(html) {
  if (typeof html !== 'string') return ''
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Split text into sentence-ish units, tolerating both Chinese and Latin stops. */
export function splitSentences(text) {
  const source = String(text ?? '')
  const minimum = minPassageLength(source)
  return source
    .split(/(?<=[。！？；.!?;])|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= minimum)
}

/**
 * Score one passage against an aspect's keywords.
 *
 * Counts distinct keyword hits rather than total occurrences: a page that says
 * "alcohol" forty times should not outrank one that also discusses diet,
 * pregnancy, and interactions.
 *
 * @param {string} passage
 * @param {string[]} keywords
 */
export function scorePassage(passage, keywords) {
  const haystack = passage.toLowerCase()
  let score = 0
  for (const keyword of keywords) {
    if (haystack.includes(keyword.toLowerCase())) score++
  }
  return score
}

/**
 * Pick the passages of a page most relevant to one or more aspects.
 *
 * @param {string} text plain text of the page
 * @param {readonly object[]} aspects entries of {@link DRUG_ASPECTS}
 * @param {{ max?: number }} [options]
 * @returns {{ aspect: string, text: string, score: number }[]}
 */
export function extractPassages(text, aspects, options = {}) {
  const max = options.max ?? MAX_PASSAGES
  // Floor per aspect, so a lookup that asked for several facets returns all of
  // them instead of filling the quota from whichever one scores highest.
  const perAspect = Math.max(1, Math.floor(max / Math.max(1, aspects.length)))
  const sentences = splitSentences(String(text ?? '').slice(0, MAX_PAGE_CHARS))
  const out = []
  for (const aspect of aspects) {
    const scored = sentences
      .map((sentence) => ({ aspect: aspect.label, text: sentence, score: scorePassage(sentence, aspect.keywords) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, perAspect)
    out.push(...scored)
  }
  // De-duplicate identical sentences that matched more than one aspect, and
  // keep the strongest few overall so the caller gets signal, not a page dump.
  const seen = new Set()
  return out
    .filter((entry) => {
      const key = entry.text.slice(0, 80)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, max)
}

/** Whether a URL is on a domain that counts as a drug reference. */
export function isTrustedUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return TRUSTED_SOURCE_HOSTS.some((trusted) => host === trusted || host.endsWith(`.${trusted}`))
  } catch {
    return false
  }
}

/**
 * Whether a name is written in Chinese, which decides the query language.
 *
 * A user who types 褪黑素 is reading Chinese, and the reference that will
 * actually help them is 默沙东诊疗手册, not an EMA annexe in Hungarian.
 */
export function prefersChinese(name) {
  return cjkRatio(name) > 0
}

/** A page a text extractor can actually read. PDFs rank last, not never. */
export function looksLikePdf(url) {
  const path = String(url ?? '').split(/[?#]/)[0].toLowerCase()
  return path.endsWith('.pdf') || path.includes('/pdf/')
}

/** Authority tier for a URL: 0 is best, 3 is unknown. */
export function sourceTier(url) {
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return 3
  }
  for (let tier = 0; tier < HOST_TIERS.length; tier++) {
    if (HOST_TIERS[tier].some((known) => host === known || host.endsWith(`.${known}`))) return tier
  }
  return 3
}

/** Whether a URL's host is a Chinese-language reference. */
export function isChineseUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return CHINESE_SOURCE_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))
  } catch {
    return false
  }
}

/**
 * Rank sources for a reader.
 *
 * Order of considerations: authority tier, then language match, then a page a
 * text extractor can read. A PDF is not excluded — a regulator's own
 * instructions are exactly what one wants — but it is tried after readable
 * pages, because extraction from PDFs is unreliable and an unreadable answer is
 * no answer.
 */
export function scoreSource(source, options = {}) {
  const wantChinese = options.chinese === true
  const tier = sourceTier(source.url)
  const chinese = isChineseUrl(source.url)
  const pdf = looksLikePdf(source.url)
  const languageMismatch = wantChinese
    ? (chinese ? 0 : 1)
    : 0
  return {
    tier,
    chinese,
    pdf,
    score: (3 - tier) * 10 + (languageMismatch === 0 ? 4 : 0) + (pdf ? 0 : 2)
  }
}

/**
 * Build the search queries for one drug and set of aspects.
 *
 * The drug name is kept verbatim. Aspect wording is added in the reader's own
 * language first, because a Chinese name plus Chinese clinical terms lands on a
 * Chinese reference page, and only then in English for the regulator databases.
 */
export function buildQueries(name, aspects, options = {}) {
  const drug = String(name ?? '').trim()
  if (drug.length === 0) return []
  const chinese = options.chinese ?? prefersChinese(drug)
  const queries = []
  // The caller's first aspect is what they actually asked about, so it goes
  // first: the search loop stops once it has a usable page, and a focused
  // question must not be starved by generic queries ahead of it.
  for (const aspect of aspects) {
    const terms = ASPECT_QUERY_TERMS[aspect.id]
    queries.push(terms === undefined
      ? `${drug} ${aspect.keywords.slice(0, 3).join(' ')}`
      : (chinese ? `${drug} ${terms.zh}` : `${drug} ${terms.en}`))
  }
  if (chinese) {
    queries.push(`${drug} 说明书 禁忌 相互作用 不良反应`)
    queries.push(`${drug} 默沙东诊疗手册`)
  } else {
    queries.push(`${drug} prescribing information contraindications interactions`)
  }
  return [...new Set(queries)]
}

/**
 * Look up a drug on the web through the Host's web service.
 *
 * @param {object} deps
 * @param {{ search: Function, fetch: Function }} deps.web the `ctx.web` service
 * @param {string} deps.name drug name as the user wrote it
 * @param {string} [deps.focus] optional aspect id to concentrate on
 * @param {number} [deps.maxPages] how many pages to read
 * @param {AbortSignal} [deps.signal]
 */
export async function lookupDrugOnWeb(deps) {
  const { web, name, focus, signal } = deps
  const maxPages = deps.maxPages ?? 4
  const maxQueries = deps.maxQueries ?? 3
  if (web === undefined || typeof web.search !== 'function') {
    return { performed: false, reason: 'web-unavailable', sources: [], passages: [] }
  }
  const chinese = prefersChinese(name)
  const aspects = focus !== undefined && DRUG_ASPECTS[focus] !== undefined
    ? [DRUG_ASPECTS[focus]]
    : Object.values(DRUG_ASPECTS)

  const queries = buildQueries(name, aspects, { chinese }).slice(0, maxQueries)
  const sources = []
  const seenUrls = new Set()
  let failedQueries = 0
  for (const query of queries) {
    let result
    try {
      result = await web.search({ query, maxResults: 6 }, signal)
    } catch (error) {
      failedQueries++
      if (failedQueries === queries.length) {
        return {
          performed: true,
          failed: true,
          reason: `search failed: ${error instanceof Error ? error.message : String(error)}`,
          queries,
          sources,
          passages: []
        }
      }
      continue
    }
    for (const source of result?.sources ?? []) {
      if (seenUrls.has(source.url)) continue
      seenUrls.add(source.url)
      const ranking = scoreSource(source, { chinese })
      // Only sources with some claim to authority may be quoted. An unknown
      // domain is not a drug reference, and offering one as if it were is worse
      // than admitting the lookup found nothing.
      if (ranking.tier === 3) continue
      sources.push({
        ...source,
        trusted: isTrustedUrl(source.url),
        tier: ranking.tier,
        chinese: ranking.chinese,
        pdf: ranking.pdf,
        score: ranking.score,
        // A search engine's own summary is useful context but is not a citation.
        fromSummary: false
      })
    }
    // Stop once a readable authority page is in hand; further queries cost
    // latency without changing the answer.
    if (sources.some((source) => source.tier <= 1 && source.pdf !== true)) break
  }

  const ranked = sources
    .slice()
    // Authority is the primary key and language/format only breaks ties within
    // it: a readable blog must never outrank a regulator's page.
    .sort((left, right) => (left.tier - right.tier) || (right.score - left.score))

  const passages = []
  const readUrls = new Set()
  const maxAttempts = Math.max(maxPages, maxPages * 3)
  let attempts = 0
  // The bound is on *attempts*, not on successfully-read pages. A page that
  // turns out to be unreadable or irrelevant must not consume the quota that
  // the next page needed, or one unlucky first result ends the whole lookup.
  for (const source of ranked) {
    if (passages.length >= MAX_PASSAGES) break
    if (attempts >= maxAttempts) break
    if (readUrls.has(source.url)) continue
    readUrls.add(source.url)
    attempts++
    let page
    try {
      page = await web.fetch({ url: source.url }, signal)
    } catch {
      continue
    }
    if (page?.statusCode >= 400 || page?.body?.content === undefined) continue
    const text = page.body.kind === 'html' ? htmlToText(page.body.content) : String(page.body.content)
    // An unreadable page (binary PDF payload, stub, blocked) yields nothing
    // here rather than garbage.
    if (text.length < 80) continue
    for (const passage of extractPassages(text, aspects)) {
      passages.push({
        ...passage,
        url: source.url,
        title: source.title,
        trusted: source.trusted,
        tier: source.tier
      })
    }
  }

  return {
    performed: true,
    failed: false,
    queries,
    language: chinese ? 'zh' : 'en',
    sources: ranked.slice(0, 8),
    passages: passages
      .sort((left, right) => (left.tier - right.tier) || (right.score - left.score))
      .slice(0, MAX_PASSAGES),
    trustedFound: ranked.some((source) => source.trusted),
    pagesTried: attempts,
    /** How many sources were reachable at all, for honest reporting. */
    reachable: ranked.length
  }
}
