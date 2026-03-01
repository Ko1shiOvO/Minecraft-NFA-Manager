import { Context, Schema, Tables } from 'koishi'

export const name = 'nfa'

export interface Config {
  maxFreeCount?: number // 每个用户免费获取NFA账号的次数
  admins?: string[] // 插件管理员列表，userId 数组
}

export const Config: Schema<Config> = Schema.object({
  maxFreeCount: Schema.number().default(1).description('每个用户免费获取NFA账号的次数'),
  admins: Schema.array(Schema.string()).default([]).description('插件管理员列表，userId 数组'),
})

declare module 'koishi' {
  interface Tables {
    nfa_accounts: NfaAccount
    nfa_usage: NfaUsage
    nfa_admins: NfaAdmin
  }
}

export interface NfaAccount {
  id: number
  account: string
  password: string
  mcName: string
  banStatus: 'unban' | 'ban'
  hypLevel: number
  capes: string
  status: 'available' | 'unavailable'
  createdAt: Date
  updatedAt: Date
}

export interface NfaUsage {
  id: number
  userId: string
  platformId: string
  accountId: number
  usedAt: Date
}

export interface NfaAdmin {
  id: number
  userId: string
  platform?: string // 平台标识，例如 discord/telegram/kook，或 'any'
  addedAt: Date
}

export function apply(ctx: Context, config: Config) {
  // 初始化数据库表
  ctx.model.extend('nfa_accounts', {
    id: 'unsigned',
    account: 'string',
    password: 'string',
    mcName: 'string',
    banStatus: 'string',
    hypLevel: 'unsigned',
    capes: 'string',
    status: 'string',
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  })

  ctx.model.extend('nfa_usage', {
    id: 'unsigned',
    userId: 'string',
    platformId: 'string',
    accountId: 'unsigned',
    usedAt: 'timestamp',
  })

  // 插件管理员表（可动态管理）
  ctx.model.extend('nfa_admins', {
    id: 'unsigned',
    userId: 'string',
    platform: 'string',
    addedAt: 'timestamp',
  })

  // 解析管理员标识，支持 'platform:userId' 或单独 userId（则使用当前 session.platform 或 'any'）
  function parseAdminInput(input: string | undefined, sessionPlatform?: string) {
    if (!input) return null
    const parts = input.split(':')
    if (parts.length === 2) {
      return { platform: parts[0], userId: parts[1] }
    }
    // 没有指定平台，优先使用 sessionPlatform，如果不可用则标记为 'any'
    return { platform: sessionPlatform || 'any', userId: input }
  }

  // 检查是否为 NFA 管理员（支持多平台）
  async function isNfaAdmin(session: any) {
    const uid = session?.userId
    if (!uid) return false
    if (session.authority >= 4) return true

    // 检查 config.admins，支持 'platform:userId' 或 'userId'
    const cfgAdmins: string[] = (config as any).admins || []
    const platform = session?.platform || 'any'
    if (cfgAdmins.includes(uid) || cfgAdmins.includes(`${platform}:${uid}`)) return true

    // 检查动态管理员表：匹配 userId 且 platform 相同或为 'any'
    const rows = await ctx.database.get('nfa_admins', { userId: uid })
    for (const r of rows) {
      if (!r.platform || r.platform === 'any' || r.platform === platform) return true
    }
    return false
  }

  // 新：解析并标准化平台选项（支持 discord/kook/telegram 等）
  function normalizePlatform(name?: string) {
    if (!name) return undefined
    const n = name.toLowerCase()
    if (['discord', 'kook', 'telegram', 'qq', 'onebot'].includes(n)) return n
    return name
  }

  // 帮助指令（精简并中文化）
  ctx.command('nfa.help')
    .alias('nfahelp')
    .alias('NFA帮助')
    .action(async () => {
      return [
        'NFA 插件帮助',
        '',
        '用户指令：',
        '• nfa 获取一个NFA账号（领取后账号会被移除）',
        '',
        '管理员指令（需要权限 4）：',
        '• nfa.add <account> <password> <mcName> [banStatus] [hypLevel] [capes]  (别名: addnfa, 添加NFA)',
        '• nfa.remove <account> (别名: renfa) — 移除NFA',
        '• nfa.list (别名: nfalist) — 列出所有NFA账号',
        '• nfa.stats (别名: nfastats) — 查看统计',
        '• nfa.addAdmin <userId> (别名: 添加管理员) — 添加 NFA 管理员',
        '• nfa.removeAdmin <userId> (别名: 移除管理员) — 移除 NFA 管理员',
        '• nfa.listAdmins (别名: 管理员列表) — 列出所有插件管理员',
      ].join('\n')
    })

  // 获取账号（保留原 nfa 命令不变）
  ctx.command('nfa')
    .alias('获取NFA')
    .alias('领取NFA')
    .action(async ({ session }) => {
      const { userId, platform } = session
      if (!userId) return err('无法识别用户 ID')

      const usageCount = await ctx.database.get('nfa_usage', { userId, platformId: platform })
      if (usageCount.length >= (config.maxFreeCount || 1)) return err('已达到免费获取次数，请联系管理员')

      const accounts = await ctx.database.get('nfa_accounts', { status: 'available' }, { limit: 1 })
      if (!accounts || accounts.length === 0) return err('当前没有可用的NFA账号')

      const acc = accounts[0]
      await recordUsageAndRemove(acc.id as number, userId, platform)

      return ok('NFA账号获取成功！\n' + formatAccount(acc))
    })

  // 管理：添加 NFA（归入 nfa.add）
  ctx.command('nfa.add <account> <password> <mcName> [banStatus] [hypLevel] [capes]', { authority: 4 })
    .alias('addnfa')
    .alias('添加NFA')
    .action(async ({ session }, account: string, password: string, mcName: string, banStatus?: string, hypLevel?: string, capes?: string) => {
      if (!await isNfaAdmin(session)) return err('需要 NFA 管理员权限')
      if (!account || !password || !mcName) return err('参数不完整：account password mcName 必填')
      const existing = await ctx.database.get('nfa_accounts', { account })
      if (existing.length > 0) return err(`账号 ${account} 已存在`)

      const parsedHyp = Math.max(0, parseInt(hypLevel || '0') || 0)
      const finalBan = banStatus === 'ban' ? 'ban' : 'unban'

      await ctx.database.create('nfa_accounts', {
        account,
        password,
        mcName,
        banStatus: finalBan,
        hypLevel: parsedHyp,
        capes: capes || '无',
        status: 'available',
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      return ok(`已添加 NFA: ${account} (MC: ${mcName})`)
    })

  // 管理：移除 NFA（归入 nfa.remove）
  ctx.command('nfa.remove <account>', { authority: 4 })
    .alias('renfa')
    .alias('移除NFA')
    .action(async ({ session }, account: string) => {
      if (!await isNfaAdmin(session)) return err('需要 NFA 管理员权限')
      if (!account) return err('缺少参数 account')
      const existing = await ctx.database.get('nfa_accounts', { account })
      if (existing.length === 0) return err(`账号 ${account} 不存在`)
      await ctx.database.remove('nfa_accounts', { account })
      return ok(`已删除 NFA: ${account}`)
    })

  // 管理：列出 NFA（归入 nfa.list）
  ctx.command('nfa.list', { authority: 4 })
    .alias('nfalist')
    .alias('NFA列表')
    .action(async () => {
      const accounts = await ctx.database.get('nfa_accounts', {})
      if (!accounts || accounts.length === 0) return '当前没有 NFA 账号'
      return accounts.map(acc => formatAccount(acc)).join('\n\n')
    })

  // 管理：统计（归入 nfa.stats）
  ctx.command('nfa.stats', { authority: 4 })
    .alias('nfastats')
    .alias('NFA统计')
    .action(async () => {
      const totalAccounts = await ctx.database.get('nfa_accounts', {})
      const availableAccounts = await ctx.database.get('nfa_accounts', { status: 'available' })
      const usage = await ctx.database.get('nfa_usage', {})
      return [
        '📊 NFA 统计',
        `总账号数: ${totalAccounts.length}`,
        `可用账号: ${availableAccounts.length}`,
        `不可用账号: ${totalAccounts.length - availableAccounts.length}`,
        `总使用次数: ${usage.length}`,
      ].join('\n')
    })

  // 管理：添加 NFA 管理员命令（可接受 platform:userId 或 userId [platform]）
  ctx.command('nfa.addAdmin <identifier> [platform]')
    .alias('添加管理员')
    .action(async ({ session }, identifier: string, platform?: string) => {
      if (!await isNfaAdmin(session)) return err('需要 NFA 管理员权限')
      const parsed = parseAdminInput(identifier, session.platform)
      if (!parsed) return err('参数错误')
      const finalPlatform = normalizePlatform(platform) || parsed.platform || 'any'
      const userId = parsed.userId
      const exists = await ctx.database.get('nfa_admins', { userId, platform: finalPlatform })
      if (exists.length > 0) return err('该用户已是管理员')
      await ctx.database.create('nfa_admins', { userId, platform: finalPlatform, addedAt: new Date() })
      return ok(`已添加管理员: ${finalPlatform}:${userId}`)
    })

  // 管理：移除 NFA 管理员（可接受 platform:userId 或 userId [platform]）
  ctx.command('nfa.removeAdmin <identifier> [platform]')
    .alias('移除管理员')
    .action(async ({ session }, identifier: string, platform?: string) => {
      if (!await isNfaAdmin(session)) return err('需要 NFA 管理员权限')
      const parsed = parseAdminInput(identifier, session.platform)
      if (!parsed) return err('参数错误')
      const finalPlatform = normalizePlatform(platform) || parsed.platform || 'any'
      const userId = parsed.userId
      await ctx.database.remove('nfa_admins', { userId, platform: finalPlatform })
      return ok(`已移除管理员: ${finalPlatform}:${userId}`)
    })

  // 管理：列出所有插件管理员（显示 platform:userId）
  ctx.command('nfa.listAdmins')
    .alias('管理员列表')
    .action(async ({ session }) => {
      if (!await isNfaAdmin(session)) return err('需要 NFA 管理员权限')
      const cfgAdmins: string[] = (config as any).admins || []
      const dynamic = await ctx.database.get('nfa_admins', {})
      const dynamicIds = dynamic.map(d => `${d.platform || 'any'}:${d.userId}`)
      return `静态配置管理员: ${cfgAdmins.join(', ') || '无'}\n动态管理员: ${dynamicIds.join(', ') || '无'}`
    })

  // 管理：解析器测试命令，用于验证 parseNfaString 在多种样例下的行为（仅管理员）
  ctx.command('nfa.testparse [raw...]', { authority: 4 })
    .alias('测试解析NFA')
    .action(async ({ session }, raw?: string) => {
      if (!await isNfaAdmin(session)) return err('需要 NFA 管理员权限')

      const builtInSamples = [
        'email@example.com:password123 |McName:PlayerOne [Capes:OptiFine] [unban] [3]',
        'user.name+tag@domain.co:pw123 McName=玩家 [2] [ban]',
        'simpleuser:simplepass',
        'noguildeuser@example.com:pw | McName:NoCape',
        'account_only_no_pass',
        'another@domain.com:pass|McName:Name[Capes:Steve]',
        'user:pass extra text [unban] | McName:Name',
        'useronly@example.com',
        'user:pass [1]',
        'badformat : : :',
        'email@example.com:password [Capes:Pan] McName:SomeName [5]',
        // 一些中文常见格式
        '邮箱@域名.com:密码 McName:玩家名 [unban] [4] [Capes:华丽披风]',
        'no-pass-account',
        'name:pwd |McName:测试|其他信息',
      ]

      const inputs = raw ? raw.split(/\r?\n|;|，|,/).map(s => s.trim()).filter(Boolean) : builtInSamples

      const outputs = inputs.map(line => {
        const parsed = parseNfaString(line)
        return `原文: ${line}\n解析: ${parsed ? JSON.stringify(parsed, null, 0) : '解析失败'}`
      }).join('\n\n')

      const sent = await sendPrivateToInvoker(session, outputs)
      if (sent) return ok('解析结果已私聊发送给你')
      return outputs
    })

  // 支持自动识别 NFA 文本格式（parseNfaString 在文件下方统一实现）
  // parseNfaString 已集中实现以便维护，旧实现已移除。

  // 公共辅助函数：输出格式与统一前缀
  function ok(text: string) { return `✅ ${text}` }
  function err(text: string) { return `❌ ${text}` }

  const formatAccount = (acc: Partial<NfaAccount>) => [
    `账号: ${acc.account}`,
    `密码: ${acc.password}`,
    `MC昵称: ${acc.mcName || '未知'}`,
    `封禁状态: ${acc.banStatus === 'unban' ? '未封禁' : '已封禁'}`,
    `HYP等级: ${acc.hypLevel ?? 0}`,
    `披风: ${acc.capes || '无'}`,
  ].join('\n')

  async function recordUsageAndRemove(accountId: number, userId: string, platformId: string) {
    await ctx.database.create('nfa_usage', {
      userId,
      platformId,
      accountId,
      usedAt: new Date(),
    })
    await ctx.database.remove('nfa_accounts', { id: accountId })
  }

  // 私聊发送结果（best-effort，适配常见适配器）
  async function sendPrivateToInvoker(session: any, text: string) {
    try {
      const bot = (session as any).bot
      if (bot && typeof bot.sendMessage === 'function') {
        await bot.sendMessage(session.userId, text)
        return true
      }
      if (typeof (session as any).send === 'function') {
        try { await (session as any).send(text, { private: true }); return true } catch (e) { }
      }
      if (ctx && typeof (ctx as any).send === 'function') {
        try { await (ctx as any).send(session.userId, text); return true } catch (e) { }
      }
    } catch (e) {
      // ignore
    }
    return false
  }

  // 解析 NFA 字串（统一实现，使用更稳健的简单解析以避免正则截断问题）
  function parseNfaString(s: string) {
    const src = (s || '').trim()
    if (!src) return null
    const item: Partial<NfaAccount> = {
      banStatus: 'unban',
      hypLevel: 0,
      capes: '无',
    }

    // 优先按第一个 ':' 分割为 account:password 形式
    const idx = src.indexOf(':')
    if (idx > 0) {
      item.account = src.slice(0, idx).trim()
      // 密码截取到第一个空白或 '|' 或 '[' 前
      const rest = src.slice(idx + 1).trim()
      const pw = rest.split(/\s|\||\[/)[0]
      item.password = pw || ''
    } else {
      // 若无冒号，尝试匹配邮箱或取第一个 token
      const emailMatch = src.match(/[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/)
      if (emailMatch) item.account = emailMatch[0]
      else item.account = src.split(/\s|\||\[/)[0]
    }

    // MC 昵称: 支持 McName:Name 或 |McName:Name 或 McName=Name
    const mcMatch = src.match(/McName[:=]\s*([^\]|\s\[]+)/i) || src.match(/\|?McName[:=]\s*([^\]|\s\[]+)/i)
    if (mcMatch) item.mcName = mcMatch[1].trim()

    // 披风
    const capMatch = src.match(/Capes[:=]\s*([^\]]+)/i) || src.match(/\[Capes:([^\]]+)\]/i)
    if (capMatch) item.capes = capMatch[1].trim()

    // 封禁状态
    if (/\bban\b/i.test(src)) item.banStatus = 'ban'
    else if (/\bunban\b/i.test(src)) item.banStatus = 'unban'

    // 方括号内数字作为 hyp 等级
    const numBracket = src.match(/\[(\d+)\]/)
    if (numBracket) item.hypLevel = parseInt(numBracket[1], 10) || 0

    // 备用：从管道部分提取 mcName
    if (!item.mcName) {
      const pipe = src.match(/\|\s*([^\[]+)/)
      if (pipe) {
        const part = pipe[1].trim()
        const m = part.match(/McName[:=]\s*([^\]]+)/i)
        if (m) item.mcName = m[1].trim()
      }
    }

    if (!item.account) return null
    if (!item.password) item.password = ''
    return item
  }
}