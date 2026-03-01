import { Context, Schema, Tables } from 'koishi'

export const name = 'mc-nfa-manager'

export interface Config {
  maxFreeCount?: number // 每个用户免费获取NFA账号的次数
  admins?: string[] // 插件管理员列表，userId 数组
}

export const Config: Schema<Config> = Schema.object({
  maxFreeCount: Schema.number().default(1).description('每个用户免费获取NFA账号的次数'),
  admins: Schema.array(Schema.string()).default([]).description('插件管理员列表，userId 数组'),
})

export const inject = ['database']

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
    id: { type: 'unsigned', initial: 1 },
    account: 'string',
    password: 'string',
    mcName: 'string',
    banStatus: 'string',
    hypLevel: 'unsigned',
    capes: 'string',
    status: 'string',
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, { primary: 'id', autoInc: true })

  ctx.model.extend('nfa_usage', {
    id: { type: 'unsigned', initial: 1 },
    userId: 'string',
    platformId: 'string',
    accountId: 'unsigned',
    usedAt: 'timestamp',
  }, { primary: 'id', autoInc: true })

  // 插件管理员表（可动态管理）
  ctx.model.extend('nfa_admins', {
    id: { type: 'unsigned', initial: 1 },
    userId: 'string',
    platform: 'string',
    addedAt: 'timestamp',
  }, { primary: 'id', autoInc: true })

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

  // 管理：添加 NFA（支持两种模式：自动解析或手动输入）
  ctx.command('nfa.add [input...]', { authority: 4 })
    .alias('addnfa')
    .alias('添加NFA')
    .action(async ({ session }, ...args: string[]) => {
      if (!await isNfaAdmin(session)) return err('需要 NFA 管理员权限')
      
      if (!args || args.length === 0) return err('用法: addnfa <格式化字符串> 或 addnfa <account> <password> <mcName> [banStatus] [hypLevel]')

      let account: string | undefined
      let password: string | undefined
      let mcName: string | undefined
      let banStatus: string = 'unban'
      let hypLevel: number = 0

      // 先尝试作为格式化字符串解析（包含 @ 和 McName）
      const fullInput = args.join(' ')
      if (fullInput.includes('@') && fullInput.toUpperCase().includes('MCNAME')) {
        // 格式化字符串模式
        const parsed = parseNfaString(fullInput)
        if (parsed && parsed.account && parsed.password && parsed.mcName) {
          account = parsed.account
          password = parsed.password
          mcName = parsed.mcName
          banStatus = parsed.banStatus || 'unban'
          hypLevel = parsed.hypLevel || 0
        } else {
          return err('解析失败或缺少必要信息（账号、密码、MC昵称）')
        }
      } else {
        // 手动输入模式：account password mcName [banStatus] [hypLevel]
        if (args.length < 3) {
          return err('手动模式需要至少 3 个参数: account password mcName [banStatus] [hypLevel]')
        }
        account = args[0]
        password = args[1]
        mcName = args[2]
        if (args[3]) banStatus = args[3] === 'ban' ? 'ban' : 'unban'
        if (args[4]) hypLevel = Math.max(0, parseInt(args[4]) || 0)
      }

      if (!account || !password || !mcName) return err('参数不完整：account password mcName 必填')

      const existing = await ctx.database.get('nfa_accounts', { account })
      if (existing.length > 0) return err(`账号 ${account} 已存在`)

      await ctx.database.create('nfa_accounts', {
        account,
        password,
        mcName,
        banStatus: banStatus as 'unban' | 'ban',
        hypLevel,
        capes: '无',
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
    try {
      await ctx.database.create('nfa_usage', {
        userId,
        platformId,
        accountId,
        usedAt: new Date(),
      })
    } catch (e) {
      ctx.logger.warn('Failed to record NFA usage:', e)
    }
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

  // 解析 NFA 字串（只提取：封禁状态、等级、mcName、账号、密码）
  function parseNfaString(s: string) {
    const src = (s || '').trim()
    if (!src) return null

    const item: Partial<NfaAccount> = {}

    // 1. 提取 [unban] 或 [ban]
    if (/\[unban\]/i.test(src)) {
      item.banStatus = 'unban'
    } else if (/\[ban\]/i.test(src)) {
      item.banStatus = 'ban'
    } else {
      item.banStatus = 'unban'
    }

    // 2. 提取 [数字] - 取第一个数字括号
    const levelMatch = src.match(/\[(\d+)\]/)
    item.hypLevel = levelMatch ? parseInt(levelMatch[1], 10) : 0

    // 3. 提取 McName - 关键：先找到 McName 标记，然后提取值
    const mcNameIdx = src.indexOf('McName')
    if (mcNameIdx !== -1) {
      // 找到冒号或等号
      const colonIdx = src.indexOf(':', mcNameIdx)
      const eqIdx = src.indexOf('=', mcNameIdx)
      const startIdx = Math.max(colonIdx, eqIdx)

      if (startIdx !== -1) {
        // 从冒号/等号后开始，找到第一个空格、管道符或括号，就是 McName 的结尾
        let endIdx = src.length
        for (let i = startIdx + 1; i < src.length; i++) {
          if (src[i] === ' ' || src[i] === '|' || src[i] === '[') {
            endIdx = i
            break
          }
        }
        item.mcName = src.substring(startIdx + 1, endIdx).trim()
      }
    }

    // 4. 提取账号和密码 - 关键：先去掉所有开头的 [xxx] 前缀
    // 找到第一个不是 [ 的字符位置
    let contentStart = 0
    while (contentStart < src.length && src[contentStart] === '[') {
      const closeIdx = src.indexOf(']', contentStart)
      if (closeIdx === -1) break
      contentStart = closeIdx + 1
    }
    const cleanedStr = src.substring(contentStart).trim()

    // 现在在清理后的字符串中查找 email:password
    // 逐个字符扫描，找 @ 符号，然后向前向后扩展以获得完整的 email 和 password
    const atIdx = cleanedStr.indexOf('@')
    if (atIdx !== -1) {
      // 向前找邮箱起点（找第一个非法邮箱字符）
      let emailStart = 0
      for (let i = atIdx - 1; i >= 0; i--) {
        if (!/[\w.%+-]/.test(cleanedStr[i])) {
          emailStart = i + 1
          break
        }
      }

      // 向后找邮箱结尾（到冒号）
      const colonIdx2 = cleanedStr.indexOf(':', atIdx)
      if (colonIdx2 !== -1) {
        item.account = cleanedStr.substring(emailStart, colonIdx2).trim()

        // 密码：从冒号后开始，到空格/管道符/括号为止
        let pwdStart = colonIdx2 + 1
        let pwdEnd = cleanedStr.length
        for (let i = pwdStart; i < cleanedStr.length; i++) {
          if (cleanedStr[i] === ' ' || cleanedStr[i] === '|' || cleanedStr[i] === '[') {
            pwdEnd = i
            break
          }
        }
        item.password = cleanedStr.substring(pwdStart, pwdEnd).trim()
      }
    }

    // 验证必要字段都存在
    if (!item.account || !item.password || !item.mcName) {
      return null
    }

    item.capes = '无'
    return item
  }
}