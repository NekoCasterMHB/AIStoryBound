import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseSkillMd, skillPromptBlocks } from './ai-skills'

const SKILL_MD = `---
name: 测试玩法
description: 用于验证注入过滤
---

## 步骤
按指引执行。

### 示例
这段示例不应注入。
`

test('skillPromptBlocks: 注入正文(剥示例)+ 参考附件', () => {
  const skill = parseSkillMd(SKILL_MD)
  skill.attachments = [
    { name: 'reference.md', text: '参考规则内容' },
    { name: 'assets/rules.txt', text: '附加规则' }
  ]
  const blocks = skillPromptBlocks(skill)
  assert.equal(blocks.length, 3)
  assert.match(blocks[0]!, /按指引执行/)
  assert.doesNotMatch(blocks[0]!, /这段示例不应注入/)
  assert.match(blocks[1]!, /参考文件:reference\.md/)
  assert.match(blocks[2]!, /参考文件:assets\/rules\.txt/)
})

test('skillPromptBlocks: README/LICENSE 不进提示词(根目录 + 子目录 + 旧安装残留)', () => {
  const skill = parseSkillMd(SKILL_MD)
  skill.attachments = [
    { name: 'README.md', text: '根目录商城说明' },
    { name: 'docs/README.md', text: '子目录说明' },
    { name: 'LICENSE', text: 'MIT License' },
    { name: 'sub/LICENSE.txt', text: '子目录许可' },
    { name: 'reference.md', text: '真正的参考内容' }
  ]
  const joined = skillPromptBlocks(skill).join('\n')
  assert.match(joined, /真正的参考内容/)
  assert.doesNotMatch(joined, /商城说明/)
  assert.doesNotMatch(joined, /子目录说明/)
  assert.doesNotMatch(joined, /MIT License/)
  assert.doesNotMatch(joined, /子目录许可/)
})
