/**
 * Web-lookup helpers: HTML to text, passage scoring, source ranking, query
 * building. Network-free, so the whole extraction path is verifiable here
 * rather than only through a live search.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DRUG_ASPECTS,
  TRUSTED_SOURCE_HOSTS,
  buildQueries,
  extractPassages,
  htmlToText,
  isTrustedUrl,
  looksLikePdf,
  lookupDrugOnWeb,
  prefersChinese,
  scorePassage,
  scoreSource,
  splitSentences
} from '../src/drug-web.js'

// --------------------------------------------------------------- html text ---

test('htmlToText: strips markup, scripts and entities', () => {
  const html = [
    '<html><head><style>.a{color:red}</style><script>var x = 1 < 2;</script></head>',
    '<body><h1>Melatonin</h1>',
    '<p>Take 30&nbsp;minutes before bed &amp; avoid alcohol.</p>',
    '<ul><li>Item one</li><li>Item two</li></ul>',
    '<!-- a comment -->',
    '</body></html>'
  ].join('')
  const text = htmlToText(html)
  assert.equal(/script|style|<|>/.test(text), false, `markup leaked: ${text}`)
  assert.match(text, /Melatonin/)
  assert.match(text, /Take 30 minutes before bed & avoid alcohol\./)
  assert.match(text, /Item one/)
  assert.match(text, /Item two/)
  assert.equal(htmlToText(undefined), '')
  assert.equal(htmlToText(42), '')
})

test('htmlToText: keeps paragraph boundaries so sentences stay separable', () => {
  const text = htmlToText('<p>First sentence about dosing.</p><p>Second sentence about alcohol.</p>')
  assert.equal(text.includes('First sentence about dosing. Second sentence about alcohol.'), false,
    'paragraphs must not be glued together')
  assert.ok(text.split('\n').length >= 2)
})

// ---------------------------------------------------------------- sentences ---

test('splitSentences: handles Chinese and Latin stops, drops fragments', () => {
  const sentences = splitSentences(
    '这是关于酒精的第一句完整说明，长度足够被保留下来。短句。Another full sentence about interactions and diet.'
  )
  assert.ok(sentences.some((sentence) => sentence.includes('酒精')))
  assert.ok(sentences.some((sentence) => sentence.includes('Another full sentence')))
  assert.equal(sentences.includes('短句。'), false, 'too-short fragments are dropped')
})

// ------------------------------------------------------------------- scoring ---

test('scorePassage: counts distinct keyword hits, not repetitions', () => {
  const aspects = DRUG_ASPECTS.restrictions
  const repetitive = `alcohol alcohol alcohol alcohol ${'x'.repeat(60)}`
  const varied = `avoid alcohol and food interactions, take with meals ${'x'.repeat(10)}`
  assert.ok(scorePassage(varied, aspects.keywords) > scorePassage(repetitive, aspects.keywords),
    'a passage covering several facets must outrank one repeating a single word')
})

test('extractPassages: returns aspect-tagged sentences and de-duplicates', () => {
  const page = [
    '异维A酸必须随餐服用，餐中应含有脂肪以提高吸收率，空腹服用会明显降低吸收。',
    '服药期间应避免饮酒，酒精会加重血脂升高与肝酶异常，并可能增加胰腺炎风险。',
    '建议定期复查血脂与肝功能，尤其是甘油三酯水平，育龄女性还需按医嘱做妊娠试验。',
    'This paragraph is about the weather and mentions nothing useful at all here.'
  ].join('\n')
  const passages = extractPassages(page, [DRUG_ASPECTS.restrictions, DRUG_ASPECTS.monitoring])
  assert.ok(passages.length >= 2)
  for (const passage of passages) {
    assert.equal(typeof passage.aspect, 'string')
    assert.equal(typeof passage.score, 'number')
    assert.ok(passage.score > 0, 'only matching passages are returned')
  }
  assert.ok(passages.some((passage) => /酒精/.test(passage.text)))
  assert.ok(passages.some((passage) => /复查|监测|肝功能/.test(passage.text)))
  assert.equal(passages.some((passage) => /weather/.test(passage.text)), false)

  const seen = new Set()
  for (const passage of passages) {
    const key = passage.text.slice(0, 80)
    assert.equal(seen.has(key), false, 'duplicate passages must be removed')
    seen.add(key)
  }
})

test('extractPassages: max caps the result and covers several facets', () => {
  const restriction = Array.from({ length: 12 }, (_, index) =>
    `关于酒精与相互作用的说明第 ${index} 条，内容足够长以便被当作一个完整句子保留下来。`)
  const monitoring = Array.from({ length: 12 }, (_, index) =>
    `关于复查与监测项目的说明第 ${index} 条，内容足够长以便被当作一个完整句子保留下来。`)
  const page = [...restriction, ...monitoring].join('\n')

  const capped = extractPassages(page, [DRUG_ASPECTS.restrictions, DRUG_ASPECTS.monitoring], { max: 6 })
  assert.equal(capped.length, 6, 'max must bound the result')

  // A lookup that asked about two facets must answer both, not spend its whole
  // quota on whichever one scores higher.
  const aspects = new Set(capped.map((passage) => passage.aspect))
  assert.equal(aspects.size, 2, `both facets must appear: ${[...aspects].join(', ')}`)
})

// ------------------------------------------------------------------- sources ---

test('isTrustedUrl: accepts drug references and rejects blogs', () => {
  assert.equal(isTrustedUrl('https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1'), true)
  assert.equal(isTrustedUrl('https://medlineplus.gov/druginfo/meds/a682095.html'), true)
  assert.equal(isTrustedUrl('https://www.fda.gov/drugs/x'), true)
  assert.equal(isTrustedUrl('https://pubmed.ncbi.nlm.nih.gov/12345/'), true)
  assert.equal(isTrustedUrl('https://some-wellness-blog.example/melatonin'), false)
  assert.equal(isTrustedUrl('not a url'), false)
  assert.ok(TRUSTED_SOURCE_HOSTS.length > 5)
})

test('buildQueries: keeps the drug name verbatim and covers the aspects', () => {
  const queries = buildQueries('褪黑素', [DRUG_ASPECTS.timing, DRUG_ASPECTS.dosing])
  assert.ok(queries.length >= 3)
  assert.ok(queries.every((query) => query.includes('褪黑素')), 'every query names the drug')
  assert.equal(new Set(queries).size, queries.length, 'queries are de-duplicated')
  assert.deepEqual(buildQueries('', [DRUG_ASPECTS.timing]), [])
})

// ------------------------------------------------------- language and region ---

test('prefersChinese: a Chinese drug name asks for Chinese sources', () => {
  assert.equal(prefersChinese('褪黑素'), true)
  assert.equal(prefersChinese('异维A酸'), true)
  assert.equal(prefersChinese('melatonin'), false)
  assert.equal(prefersChinese('isotretinoin 20mg'), false)
})

test('buildQueries: wording follows the reader\'s language', () => {
  const zh = buildQueries('褪黑素', [DRUG_ASPECTS.timing], { chinese: true })
  assert.ok(zh.some((query) => /睡前|时机|服用时间/.test(query)), `expected a Chinese timing query: ${zh.join(' | ')}`)
  assert.ok(zh.some((query) => query.includes('默沙东')), 'a Chinese manual query helps land on a Chinese reference')

  const en = buildQueries('melatonin', [DRUG_ASPECTS.timing], { chinese: false })
  assert.ok(en.some((query) => /timing|when to take/i.test(query)), `expected an English timing query: ${en.join(' | ')}`)
  assert.equal(en.some((query) => query.includes('默沙东')), false)
})

test('scoreSource: authority outranks language, and a PDF ranks below readable HTML', () => {
  const chineseBlog = scoreSource({ url: 'https://blog.example.cn/x' }, { chinese: true })
  const englishRegulator = scoreSource({ url: 'https://dailymed.nlm.nih.gov/dailymed/x.cfm' }, { chinese: true })
  assert.ok(englishRegulator.tier < chineseBlog.tier, 'a regulator beats a blog in any language')

  assert.equal(looksLikePdf('https://a.example/doc.pdf?x=1'), true)
  assert.equal(looksLikePdf('https://a.example/doc.html'), false)
  assert.equal(scoreSource({ url: 'https://www.ema.europa.eu/en/documents/x_en.pdf' }).pdf, true)
  assert.equal(scoreSource({ url: 'https://medlineplus.gov/druginfo/x.html' }).pdf, false)
})

test('lookupDrugOnWeb: a Chinese name searches in Chinese and prefers Chinese hosts', async () => {
  const queries = []
  const web = {
    async search(request) {
      queries.push(request.query)
      return {
        sources: [
          { url: 'https://dailymed.nlm.nih.gov/dailymed/x.cfm', title: 'DailyMed' },
          { url: 'http://www.msdmanuals.cn/professional/special-subjects/dietary-supplements/melatonin', title: '默沙东诊疗手册' }
        ],
        truncated: false
      }
    },
    async fetch(request) {
      return {
        url: request.url,
        statusCode: 200,
        truncated: false,
        body: {
          kind: 'html',
          // A realistic reference page: the quotable detail is surrounded by
          // other prose, not a lone sentence.
          content: '<p>褪黑素是一种由松果体分泌的激素，具有调节昼夜节律的作用，在部分国家按药物管理。'
            + '本品用于昼夜节律相关睡眠问题的短期调节，例如时差与睡眠时相延迟。</p>'
            + '<p>褪黑素通常建议在就寝前服用，但对于睡眠时相延迟的患者，需要比目标就寝时间更早给药，'
            + '并配合固定的起床时间才能推动相位前移。</p>'
            + '<p>服药期间应避免饮酒，并注意可能出现头痛、头晕、嗜睡，且可能加重已有的抑郁情绪。</p>'
        }
      }
    }
  }

  const result = await lookupDrugOnWeb({ web, name: '褪黑素', focus: 'timing' })
  assert.ok(queries.some((query) => /睡前|时机|服用时间|默沙东/.test(query)), `queries: ${queries.join(' | ')}`)
  assert.equal(result.language, 'zh')
  assert.ok(result.passages.length > 0, 'a Chinese HTML page must yield quotable passages')
  assert.ok(result.passages.some((passage) => /就寝前|睡前|更早给药/.test(passage.text)),
    `passages: ${result.passages.map((p) => p.text).join(' || ')}`)
})

test('lookupDrugOnWeb: a PDF is read after a readable page of equal authority', async () => {
  const order = []
  const web = {
    async search() {
      return {
        sources: [
          { url: 'https://www.ema.europa.eu/en/documents/product-information/x_en.pdf', title: 'EMA PDF' },
          { url: 'https://medlineplus.gov/druginfo/meds/a682095.html', title: 'MedlinePlus' }
        ],
        truncated: false
      }
    },
    async fetch(request) {
      order.push(request.url)
      return {
        url: request.url,
        statusCode: 200,
        truncated: false,
        body: { kind: 'html', content: `<p>${'Alcohol and interactions should be considered carefully. '.repeat(4)}</p>` }
      }
    }
  }
  const result = await lookupDrugOnWeb({ web, name: 'melatonin' })
  assert.equal(order[0], 'https://medlineplus.gov/druginfo/meds/a682095.html',
    `a readable page must be read before a PDF of the same rank, got: ${order.join(' | ')}`)
  assert.ok(result.passages.length > 0)
  assert.ok(result.pagesTried >= 1)
})

// -------------------------------------------------------------- the lookup ---

test('lookupDrugOnWeb: ranks trusted sources first, drops junk, reads bounded pages', async () => {
  const fetched = []
  const web = {
    async search() {
      return {
        sources: [
          { url: 'https://blog.example/melatonin', title: 'Blog' },
          { url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1', title: 'DailyMed' },
          { url: 'https://medlineplus.gov/druginfo/meds/a682095.html', title: 'MedlinePlus' }
        ],
        truncated: false
      }
    },
    async fetch(request) {
      fetched.push(request.url)
      if (request.url.includes('medlineplus')) {
        return {
          url: request.url,
          statusCode: 200,
          truncated: false,
          body: {
            kind: 'html',
            content: '<p>Melatonin is usually taken 30 to 60 minutes before bedtime to help with sleep timing.</p>'
          }
        }
      }
      return { url: request.url, statusCode: 200, truncated: false, body: { kind: 'text', content: 'nothing useful' } }
    }
  }

  const result = await lookupDrugOnWeb({ web, name: 'melatonin' })
  assert.equal(result.performed, true)
  assert.equal(result.failed, false)
  assert.equal(result.trustedFound, true)
  // An unrelated blog is not a drug reference and must not be offered as one.
  assert.equal(result.sources.some((source) => source.url.includes('blog.example')), false,
    `junk sources must be filtered: ${result.sources.map((s) => s.url).join(' | ')}`)
  assert.equal(result.sources[0].tier, 0, 'the regulator must rank first')
  assert.ok(fetched[0].includes('dailymed') || fetched[0].includes('medlineplus'),
    `an authoritative page must be read first: ${fetched.join(' | ')}`)
  assert.ok(result.passages.length > 0)
  assert.ok(result.passages.every((passage) => typeof passage.url === 'string'))
  assert.ok(result.pagesTried <= 12, `attempts stay bounded: ${result.pagesTried}`)
  assert.ok(result.reachable >= 1)
})

test('lookupDrugOnWeb: reports failures instead of throwing', async () => {
  const failing = { async search() { throw new Error('no provider') }, async fetch() { throw new Error('x') } }
  const result = await lookupDrugOnWeb({ web: failing, name: 'anything' })
  assert.equal(result.performed, true)
  assert.equal(result.failed, true)
  assert.match(result.reason, /no provider/)
  assert.deepEqual(result.passages, [])
})

test('lookupDrugOnWeb: a missing web service is reported, not thrown', async () => {
  const result = await lookupDrugOnWeb({ web: undefined, name: 'melatonin' })
  assert.equal(result.performed, false)
  assert.equal(result.reason, 'web-unavailable')
})
