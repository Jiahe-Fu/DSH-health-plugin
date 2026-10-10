/**
 * Medication knowledge base and the user's standing regimen.
 *
 * Two different things live here, and keeping them apart matters:
 *
 * - `FORMULATIONS` and `DRUG_NOTES` are written reference data. They exist so
 *   the assistant does not improvise dietary restrictions or monitoring advice,
 *   and so every claim it makes is traceable to a line in this file.
 * - `normalizeRegimen` validates what the *user* says they were prescribed.
 *   This plugin never decides a dose, a frequency, or whether to take a drug
 *   with food: it records what the prescriber said and holds the assistant to
 *   it. A dose is clinical authority, and that is not ours.
 *
 * ## Provenance and copyright
 *
 * The entries below state **clinical facts in this project's own wording**:
 * this drug is avoided in pregnancy, this one interacts with warfarin, watch
 * the liver panel. Facts of that kind are not copyrightable, and neither is a
 * short factual list.
 *
 * What is deliberately NOT here is reproduced or closely paraphrased prose from
 * a manual, datasheet or product information document. Those are copyrighted,
 * this project has no licence to redistribute them, and copying them into a
 * published npm package would be a redistribution. Instead each entry links to
 * where the underlying information comes from, and the reader follows the link.
 * If a sourced document needs to be quoted rather than summarised, that is what
 * the plugin's web lookup does at runtime — it quotes passages **with their
 * source** instead of baking them into this file.
 *
 * Nothing here is a substitute for the label or the prescriber, which is why
 * every entry carries the fields a pharmacist would check and why the tool
 * returns `prescriberOfRecord` alongside them.
 */

/**
 * Dosage forms, with the reasoning a patient actually needs: can it be split,
 * must it be swallowed whole, does it need a full glass of water.
 */
export const FORMULATIONS = {
  tablet: {
    label: '片剂',
    splittable: true,
    note: '多数片剂可沿刻痕掰开，但缓释、肠溶片除外。'
  },
  capsule: {
    label: '胶囊',
    splittable: false,
    note: '必须整粒吞服，拆开会改变吸收速度并刺激食道。'
  },
  softgel: {
    label: '软胶囊',
    splittable: false,
    note: '必须整粒吞服，随餐服用可提高脂溶性药物吸收。'
  },
  sustained_release: {
    label: '缓释片',
    splittable: false,
    note: '必须整片吞服。掰开或嚼碎会造成剂量突释。'
  },
  enteric: {
    label: '肠溶片',
    splittable: false,
    note: '必须整片吞服，不能与抑酸药同服，否则包衣提前崩解。'
  },
  solution: {
    label: '溶液',
    splittable: false,
    note: '按刻度取量，不要用汤匙估量。'
  }
}

/**
 * Written notes for the drugs this plugin knows about.
 *
 * Each entry is deliberately conservative: it states the label-level facts and
 * the routine monitoring, and it hands the clinical decision back to the
 * prescriber rather than making one.
 */
export const DRUG_NOTES = {
  isotretinoin: {
    name: '异维A酸',
    aliases: ['异维A酸', '异维甲酸', 'isotretinoin', 'accutane', 'roaccutane', '泰尔丝', '保肤灵'],
    drugClass: '口服维A酸类（ retinoid ）',
    usedFor: '中重度痤疮，尤其是结节囊肿型或对常规治疗无效者',
    /** Formulations matter for "how do I take it". */
    commonFormulations: ['softgel', 'capsule'],
    /** The label facts a patient is most likely to get wrong. */
    intake: {
      withFood: 'must',
      foodNote: '必须随餐服用，且餐食应含脂肪。空腹服用的吸收率明显下降，等于白吃。',
      splitting: '软胶囊/胶囊需整粒吞服，不要拆开或咀嚼。',
      timingNote: '剂量与分次（每日一次或分两次）由医生根据体重与耐受性决定，按处方执行。'
    },
    /** Absolute or near-absolute no-goes, stated plainly. */
    restrictions: [
      { id: 'pregnancy', severity: 'absolute', text: '妊娠期绝对禁用。该药有明确致畸性，育龄女性必须落实避孕并遵医嘱做妊娠试验。' },
      { id: 'blood_donation', severity: 'absolute', text: '服药期间及停药后至少 1 个月内不得献血，避免受血者暴露。' },
      { id: 'vitamin_a', severity: 'avoid', text: '不要再额外补充维生素A或含维A的复合维生素，会叠加中毒风险。' },
      { id: 'alcohol', severity: 'avoid', text: '避免饮酒。酒精会加重血脂升高与肝酶异常，并可能增加胰腺炎风险。' },
      { id: 'tetracycline', severity: 'avoid', text: '不要与四环素类抗生素同服，会显著增加颅内压升高（假性脑瘤）风险。' },
      { id: 'laser_dermabrasion', severity: 'avoid', text: '服药期间及停药后数月内避免磨皮、激光等皮肤操作，瘢痕与色素异常风险升高。' },
      { id: 'contact_lens', severity: 'caution', text: '干眼常见，隐形眼镜可能难以耐受，建议减少佩戴时间。' },
      { id: 'sun', severity: 'caution', text: '光敏性升高，注意物理防晒。' }
    ],
    sideEffects: [
      { id: 'dry_skin', text: '皮肤干燥、脱屑，最常见，通常与剂量相关。' },
      { id: 'dry_lips', text: '唇炎几乎是必然的，建议预防性使用润唇膏而不是等裂开。' },
      { id: 'dry_eyes', text: '眼干，可用人工泪液。' },
      { id: 'dry_nose', text: '鼻干、鼻出血，可用生理盐水鼻喷。' },
      { id: 'muscle_ache', text: '肌痛、关节痛，剧烈运动可能加重。' },
      { id: 'photosensitivity', text: '光敏。' },
      { id: 'rash', text: '皮疹，多为暂时性。' }
    ],
    /** Routine labs. Which ones and the cadence are the prescriber's call. */
    monitoring: [
      { id: 'lipids', text: '血脂（尤其甘油三酯）：该药会升高，基线及服药后复查。' },
      { id: 'liver', text: '肝功能：可能升高转氨酶，需定期复查。' },
      { id: 'pregnancy_test', text: '育龄女性按医嘱做妊娠试验。' },
      { id: 'mood', text: '情绪：留意抑郁、易激惹、情绪波动。' }
    ],
    /** Persistent support a patient should plan for. */
    supportiveCare: [
      { id: 'hydrate', text: '保证饮水，全天规律补水有助于缓解黏膜干燥。' },
      { id: 'lip_balm', text: '随身携带润唇膏，每天多次使用。' },
      { id: 'moisturizer', text: '温和保湿霜，洗澡水不要太烫、时间不要太长。' },
      { id: 'eye_drops', text: '无防腐剂人工泪液，按需使用。' },
      { id: 'humidity', text: '干燥季节可用加湿器。' }
    ],
    /** The short list that must be repeated in every reminder. */
    reminderEssentials: [
      '随餐服用，餐中要有脂肪',
      '整粒吞服，不要咬破',
      '不喝酒',
      '不额外补维生素A',
      '记得补水、润唇、保湿'
    ],
    /** When this stops being a side effect and becomes a reason to call someone. */
    redFlags: [
      { id: 'vision', text: '视力突然改变、视物模糊或持续头痛：可能是颅内压升高，尽快就医。' },
      { id: 'severe_abdominal', text: '剧烈腹痛、持续恶心呕吐：警惕胰腺炎，需急诊。' },
      { id: 'mood', text: '情绪显著低落、绝望、出现自伤或自杀念头：立即联系医生或心理危机热线（12356 / 120）。' },
      { id: 'jaundice', text: '皮肤或眼白发黄、尿色深如浓茶：提示肝损伤，尽快就医。' },
      { id: 'severe_skin', text: '大面积水疱、口腔黏膜糜烂、发热伴皮疹：需急诊。' },
      { id: 'breath', text: '呼吸困难或面部肿胀：可能为严重过敏，立即急救。' }
    ],
    references: [
      {
        label: 'DailyMed（美国 NLM 药品标签库）：isotretinoin',
        url: 'https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=isotretinoin',
        kind: 'regulator'
      },
      {
        label: '国家药品监督管理局：药品查询',
        url: 'https://www.nmpa.gov.cn/datasearch/home-index.html',
        kind: 'regulator'
      }
    ],
    prescriberOfRecord: '剂量、疗程时长、分次方式、复查频率全部以处方和医生交代为准；本插件只做记录与提醒，不调整剂量。'
  },

  // A second entry so the shape is exercised by more than one drug and the
  // lookup path is not accidentally hardcoded to a single name.
  doxycycline: {
    name: '多西环素',
    aliases: ['多西环素', '强力霉素', 'doxycycline', 'vibramycin'],
    drugClass: '四环素类抗生素',
    usedFor: '痤疮、呼吸道感染、某些蜱媒疾病',
    commonFormulations: ['tablet', 'capsule'],
    intake: {
      withFood: 'either',
      foodNote: '可与食物同服以减少胃部不适，但不要与含钙、镁、铁的食物或补剂同时服用。',
      splitting: '整粒/整片吞服，用足量水送服，服后保持直立至少 30 分钟。',
      timingNote: '按处方间隔服用。'
    },
    restrictions: [
      { id: 'dairy_mineral', severity: 'separate', text: '牛奶、钙片、铁剂、含镁抗酸药会显著降低吸收，需间隔 2 小时以上。' },
      { id: 'sun', severity: 'caution', text: '光敏性升高，注意防晒。' },
      { id: 'pregnancy', severity: 'absolute', text: '妊娠期及 8 岁以下儿童禁用（影响牙齿与骨骼发育）。' }
    ],
    sideEffects: [
      { id: 'esophagitis', text: '食管刺激：饮水不足或服后立即躺下会引起烧灼感。' },
      { id: 'nausea', text: '恶心、胃部不适。' },
      { id: 'photosensitivity', text: '光敏。' },
      { id: 'candidiasis', text: '可能引起念珠菌感染。' }
    ],
    monitoring: [
      { id: 'symptom_response', text: '按医嘱观察疗效与不良反应。' }
    ],
    supportiveCare: [
      { id: 'water', text: '每次用足量水送服，服后 30 分钟内不要躺下。' }
    ],
    reminderEssentials: [
      '用足量水送服，服后 30 分钟别躺下',
      '与牛奶、钙片、铁剂间隔 2 小时以上',
      '注意防晒'
    ],
    redFlags: [
      { id: 'severe_skin', text: '严重皮疹、水疱或发热伴皮疹：停药并尽快就医。' },
      { id: 'breath', text: '呼吸困难或面部肿胀：立即急救。' }
    ],
    references: [
      {
        label: 'DailyMed（美国 NLM 药品标签库）：doxycycline',
        url: 'https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=doxycycline',
        kind: 'regulator'
      }
    ],
    prescriberOfRecord: '剂量与疗程以处方为准；抗生素疗程不要自行提前停用。'
  },

  /**
   * Melatonin.
   *
   * The facts below are stated in this project's own words and are drawn from
   * the linked references; nothing is quoted from them. See the file header for
   * why that distinction is enforced rather than cosmetic.
   *
   * The efficacy line is here on purpose. Melatonin is widely sold as a sleep
   * remedy, and a user who expects it to fix a three-hour sleep onset deserves
   * the measured effect size before concluding the product is defective or that
   * a larger dose is the answer.
   */
  melatonin: {
    name: '褪黑素',
    aliases: ['褪黑素', '松果体素', 'melatonin', '美拉托宁'],
    drugClass: '内源性激素；在不同国家分别按药物或膳食补充剂管理',
    usedFor: '昼夜节律相关睡眠问题的短期调节，例如时差、睡眠时相延迟、轮班后的睡眠调整',
    commonFormulations: ['tablet', 'sustained_release', 'solution'],
    evidenceNote: '19 项随机对照研究（1683 名受试者）的荟萃分析报告的效应量约为：'
      + '缩短入睡时间 7 分钟、延长总睡眠时间 8 分钟，并改善主观睡眠质量。'
      + '针对时差与睡眠时相延迟的证据相对更强；针对一般"失眠"的证据较弱。',
    productVariability: '不同产品的实际含量差异显著，部分产品还可能含其他成分。'
      + '"吃了一片"并不等于知道吃进了多少——这是把剂量交给包装说明书的另一个理由。',
    intake: {
      withFood: 'either',
      foodNote: '可与食物同服，也可空腹；差别主要在吸收速度。',
      splitting: '按包装说明服用；标注缓释（常写作 MR / 缓释）的必须整片吞服，不可掰开或嚼碎。',
      timingNote: '时差场景的常见用法是就寝前服用。若问题是**睡眠时相延迟**（身体习惯很晚才困），'
        + '关键在于比目标就寝时间**更早**给药，并配合固定起床时间，而不是躺下才吃。'
    },
    restrictions: [
      { id: 'driving', severity: 'caution', text: '可能出现嗜睡，服后不要驾驶或操作危险机械。' },
      { id: 'depression', severity: 'absolute', text: '可能加重已有的抑郁。有抑郁史或当前情绪低落者，使用前先问医生。' },
      { id: 'epilepsy', severity: 'avoid', text: '可能降低抗癫痫药疗效、增加发作风险，癫痫患者须先问医生。' },
      { id: 'warfarin', severity: 'avoid', text: '可能增强华法林作用、增加出血风险，需医生评估。' },
      { id: 'sedatives', severity: 'caution', text: '可能增强苯二氮卓类等镇静药的作用，叠加时嗜睡更明显。' },
      { id: 'interacting_drugs', severity: 'caution', text: '氟伏沙明、雌激素、喹诺酮类抗生素可能升高体内褪黑素水平；卡马西平与利福平可能降低。' },
      { id: 'alcohol', severity: 'avoid', text: '酒精本身干扰睡眠结构，也可能与嗜睡副作用叠加，晚间应避免。' },
      { id: 'pregnancy', severity: 'caution', text: '妊娠期与哺乳期安全性数据不足，使用前请咨询医生。' }
    ],
    sideEffects: [
      { id: 'drowsy', text: '头痛、头晕、恶心、嗜睡。' },
      { id: 'mood', text: '可能出现情绪低落；已有抑郁者可能加重。' },
      { id: 'daytime', text: '部分人作用时间偏长，出现白天困倦。' },
      { id: 'vivid', text: '多梦或梦境鲜明，多见于实际摄入量偏高时。' }
    ],
    monitoring: [
      { id: 'mood_watch', text: '情绪：留意低落、易激惹或兴趣减退，出现即停用并咨询医生。' },
      { id: 'seizure_watch', text: '同时使用抗癫痫药者，需医生评估发作控制情况。' },
      { id: 'response', text: '记录服用时间与当晚入睡耗时，用来判断有没有用、吃的时间对不对。' }
    ],
    supportiveCare: [
      { id: 'fixed_wake', text: '固定起床时间（含周末）——对时相问题，这一条比服药时间更重要。' },
      { id: 'evening_dark', text: '睡前减少强光与屏幕光照；晨起尽量接触自然光。' },
      { id: 'dim_light', text: '傍晚调暗环境光，与药物配合更有利于相位前移。' }
    ],
    reminderEssentials: [
      '按包装说明服用，缓释片整片吞服',
      '服后不开车、不操作机械',
      '有抑郁史或情绪低落要先问医生',
      '留意情绪变化'
    ],
    redFlags: [
      { id: 'mood_worsening', text: '情绪明显变差、出现绝望或自伤念头：立即停用并联系医生，或拨打 12356 / 120。' },
      { id: 'bleeding', text: '服用华法林期间出现不明原因瘀青或出血：尽快就医。' },
      { id: 'seizure', text: '癫痫患者发作增多：尽快就医。' },
      { id: 'breath', text: '呼吸困难或面部肿胀：立即急救。' }
    ],
    // Where the facts come from. Links only: the documents themselves are not
    // redistributed here, and nothing above is a quotation from them.
    references: [
      {
        label: 'MSD 诊疗手册专业版：褪黑素',
        url: 'http://www.msdmanuals.cn/professional/special-subjects/dietary-supplements/melatonin',
        kind: 'reference'
      },
      {
        label: 'EMA 产品信息（褪黑素制剂，欧盟监管机构）',
        url: 'https://www.ema.europa.eu/en/documents/product-information/melatonin-neurim-epar-product-information_en.pdf',
        kind: 'regulator'
      }
    ],
    prescriberOfRecord: '剂量与是否继续使用以包装说明、药师或医生意见为准。'
      + '本插件不会建议加量或减量；"吃了一片没效果"不等于应该吃两片。'
  }
}

/** Tolerance for matching a spoken or typed drug name to a known entry. */
function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\-_（）()【】[\]、,，。.]/g, '')
    .trim()
}

/**
 * Look up written notes for a drug the user named.
 *
 * Matching is substring-based in both directions so "异维A酸软胶囊" and
 * "isotretinoin 20mg" both land on the same entry. An unknown name returns
 * `known: false` rather than a guess: inventing dietary rules for a drug this
 * file does not describe is exactly the failure this design avoids.
 *
 * @param {string} query drug name as the user wrote or said it
 */
export function lookupDrug(query) {
  const needle = normalizeName(query)
  if (needle.length === 0) {
    return { known: false, query, reason: '未提供药物名称' }
  }
  const hits = []
  for (const [id, entry] of Object.entries(DRUG_NOTES)) {
    const candidates = [entry.name, id, ...(entry.aliases ?? [])].map(normalizeName)
    if (candidates.some((candidate) => candidate.length > 0
      && (candidate.includes(needle) || needle.includes(candidate)))) {
      hits.push({ id, ...entry })
    }
  }
  if (hits.length === 0) {
    return {
      known: false,
      query,
      reason: '本插件的成文药物说明里没有这个药',
      guidance: '不要凭记忆给这个药的忌口或监测建议。改为：让用户查看药品说明书或咨询药师/医生，'
        + '同时仍可用 medication_regimen 记录处方本身（剂量、次数、时间），提醒功能不依赖知识库。'
    }
  }
  return { known: true, query, drugs: hits }
}

// ------------------------------------------------------------ the regimen ---

/** How often a standing medication is taken. */
export const REGIMEN_FREQUENCIES = ['once_daily', 'twice_daily', 'three_times_daily', 'every_other_day', 'weekly', 'as_needed', 'custom']

/** Fields a regimen entry may carry. */
export const REGIMEN_FIELDS = [
  'name', 'dose', 'unitsPerDose', 'formulation', 'frequency', 'times',
  'withFood', 'startDate', 'endDate', 'prescriber', 'reason', 'notes',
  'remind', 'active'
]

/**
 * Validate and normalize one standing medication.
 *
 * @param {object} input
 * @param {string} entryDate fallback start date
 */
export function normalizeRegimen(input, entryDate) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('a medication regimen must be an object')
  }
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length === 0) throw new TypeError('name is required (the drug name as prescribed)')

  const dose = typeof input.dose === 'string' && input.dose.trim().length > 0 ? input.dose.trim() : undefined
  const unitsPerDose = input.unitsPerDose === undefined ? undefined : positiveInteger(input.unitsPerDose, 'unitsPerDose')
  const formulation = input.formulation === undefined ? undefined : requireEnum(input.formulation, Object.keys(FORMULATIONS), 'formulation')
  const frequency = input.frequency === undefined ? 'custom' : requireEnum(input.frequency, REGIMEN_FREQUENCIES, 'frequency')

  let times
  if (input.times !== undefined) {
    if (!Array.isArray(input.times) || input.times.length === 0) {
      throw new TypeError('times must be a non-empty array of HH:MM strings')
    }
    times = input.times.map((value) => {
      const text = String(value).trim()
      const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text)
      if (match === null) throw new TypeError(`time ${JSON.stringify(value)} must look like HH:MM`)
      // Normalize to two-digit hours. Padding by string length alone turned
      // "08:00" into "008:00", which then sorted and displayed wrongly.
      return `${match[1].padStart(2, '0')}:${match[2]}`
    })
  }

  // A frequency that implies a schedule but carries no times is the single most
  // likely way a reminder silently never fires, so it is refused up front.
  if (times === undefined && (frequency === 'once_daily' || frequency === 'twice_daily' || frequency === 'three_times_daily')) {
    throw new TypeError(`frequency "${frequency}" needs times, e.g. ["08:00","20:00"] — without them no reminder can be scheduled`)
  }
  const expectedSlots = { once_daily: 1, twice_daily: 2, three_times_daily: 3 }[frequency]
  if (expectedSlots !== undefined && times.length !== expectedSlots) {
    throw new TypeError(`frequency "${frequency}" expects ${expectedSlots} time(s), got ${times.length}`)
  }

  const withFood = input.withFood === undefined ? undefined : requireEnum(input.withFood, ['must', 'either', 'empty_stomach'], 'withFood')

  return compact({
    name,
    dose,
    unitsPerDose,
    formulation,
    frequency,
    times,
    withFood,
    startDate: dateField(input.startDate, entryDate, 'startDate'),
    endDate: dateField(input.endDate, undefined, 'endDate'),
    prescriber: text(input.prescriber),
    reason: text(input.reason),
    notes: text(input.notes),
    remind: input.remind === undefined ? true : input.remind === true,
    active: input.active === undefined ? true : input.active === true
  })
}

/** A stable identity for a regimen, so the same drug is not registered twice. */
export function regimenId(regimen) {
  return normalizeName(regimen.name)
}

/**
 * The short list of things to say in a reminder for one regimen.
 *
 * Notes for the drug are merged in only when the knowledge base knows it, and
 * the user's own notes always come last so they read as the local override.
 */
export function reminderEssentials(regimen, notes) {
  const lines = []
  const doseText = [regimen.dose, regimen.unitsPerDose ? `${regimen.unitsPerDose} 粒/片` : undefined]
    .filter(Boolean).join(' ')
  lines.push(`${regimen.name}${doseText ? ` ${doseText}` : ''}`)
  if (regimen.withFood === 'must') lines.push('随餐服用，餐中要有脂肪')
  if (regimen.withFood === 'empty_stomach') lines.push('空腹服用')
  if (regimen.withFood === 'either') lines.push('可与食物同服')
  const formulation = regimen.formulation ? FORMULATIONS[regimen.formulation] : undefined
  if (formulation !== undefined && formulation.splittable === false) lines.push(formulation.note)
  if (notes?.known === true && Array.isArray(notes.drugs)) {
    for (const drug of notes.drugs) {
      for (const essential of drug.reminderEssentials ?? []) {
        if (!lines.includes(essential)) lines.push(essential)
      }
    }
  }
  if (regimen.notes) lines.push(regimen.notes)
  return lines
}

// ------------------------------------------------------------------ helpers ---

function positiveInteger(value, field) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new TypeError(`${field} must be a positive integer`)
  return n
}

function requireEnum(value, allowed, field) {
  const text = String(value)
  if (!allowed.includes(text)) {
    throw new TypeError(`${field} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`)
  }
  return text
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function dateField(value, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback
  const candidate = String(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) throw new TypeError(`${field} must be YYYY-MM-DD`)
  return candidate
}

function compact(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value
  }
  return out
}
