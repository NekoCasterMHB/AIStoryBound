// app/types/mammoth.d.ts
// mammoth 无官方类型;仅声明项目内用到的浏览器端正文提取 API
declare module 'mammoth' {
  export interface ExtractRawTextResult {
    /** 提取出的纯文本(段落间以 \n\n 分隔) */
    value: string
    messages: unknown[]
  }
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<ExtractRawTextResult>
}
