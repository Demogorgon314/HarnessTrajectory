export const chatLabels = {
  en: {
    chat: 'Chat', thinking: 'Think', context: 'Context', compaction: 'Conversation compacted',
    interrupted: 'Interrupted', limit: 'Output limit reached', retry: 'Retry',
    input: 'Input', output: 'Output', pending: 'No result recorded', failed: 'Failed',
    earlier: 'Load earlier messages', latest: 'Jump to latest', empty: 'No messages yet',
    loading: 'Loading conversation…', missing: 'The requested record is not available in this conversation.',
    copy: 'Copy', copied: 'Copied', copyFailed: 'Copy failed', footnotes: 'Footnotes',
    noOutput: 'No output',
  },
  zh: {
    chat: '对话', thinking: '思考', context: '上下文', compaction: '对话已压缩',
    interrupted: '已中断', limit: '已达到输出限制', retry: '重试',
    input: '输入', output: '输出', pending: '尚无结果记录', failed: '失败',
    earlier: '加载更早的消息', latest: '跳到最新消息', empty: '暂无消息',
    loading: '正在加载对话…', missing: '此对话中没有可定位的对应记录。',
    copy: '复制', copied: '已复制', copyFailed: '复制失败', footnotes: '脚注',
    noOutput: '无输出',
  },
}
export type ChatLabels = typeof chatLabels.en
