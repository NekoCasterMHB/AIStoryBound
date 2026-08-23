// shared/json.ts
// JSON 抽取工具(浏览器与服务器共用):从模型输出文本里提取合法 JSON(优先 ```json 围栏,否则剥离前后文字)。

/** 从模型返回文本里抽取 JSON:优先取 ```json 围栏,否则剥离前导/尾部文本后 JSON.parse */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = (fenced && fenced[1] ? fenced[1] : text)
    .replace(/^[\s\S]*?(\[|\{|")\s*/s, (_m, c) => c) // 去掉 JSON 之前的说明文字
    .trim()
  try {
    return JSON.parse(candidate) as T
  } catch {
    // 尝试截断尾部非 JSON 内容
    const inner = tryParseAfter(candidate)
    if (inner !== undefined) return inner as T
    return null
  }
}

function tryParseAfter(text: string): unknown | undefined {
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      const top = stack[stack.length - 1]
      if (top && ((top === '{' && ch === '}') || (top === '[' && ch === ']'))) {
        stack.pop()
        if (stack.length === 0) {
          try {
            return JSON.parse(text.slice(0, i + 1))
          } catch {
            return undefined
          }
        }
      }
    }
  }
  return undefined
}
