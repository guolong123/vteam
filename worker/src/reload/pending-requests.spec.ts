/**
 * 待答复项（表单/权限）共享检测能力的单测。
 *
 * 钉住两条安全性质：
 * 1. **逐会话**查（与 location 无关）——全局端点按 location 作用域，会漏判；
 * 2. 任一会话查询失败 ⇒ `incomplete = true`（结论不完整 ⇒ 调用方不得放行重载）。
 */
import {
  detectPendingRequests,
  emptyPendingSnapshot,
  fetchPendingForms,
  fetchPendingPermissions,
  PendingRequestSource,
} from './pending-requests';

function makeSource(
  forms: Record<string, string[]> = {},
  permissions: Record<string, string[]> = {},
  failOn: string[] = [],
): PendingRequestSource {
  return {
    listQuestions: async (sessionID: string) => {
      if (failOn.includes(sessionID)) {
        throw new Error(`query failed: ${sessionID}`);
      }
      return (forms[sessionID] ?? []).map((id) => ({
        id,
        sessionId: sessionID,
        questions: [],
      }));
    },
    listPermissions: async (sessionID: string) => {
      if (failOn.includes(sessionID)) {
        throw new Error(`query failed: ${sessionID}`);
      }
      return (permissions[sessionID] ?? []).map((id) => ({
        id,
        sessionId: sessionID,
        action: 'shell',
        resources: [],
      }));
    },
  };
}

describe('detectPendingRequests（待答复项检测）', () => {
  it('无 pending ⇒ 空快照（结论完整）', async () => {
    const result = await detectPendingRequests(makeSource(), ['ses_1', 'ses_2']);
    expect(result).toEqual(emptyPendingSnapshot());
    expect(result.incomplete).toBe(false);
  });

  it('统计表单与权限，并记下涉及的会话', async () => {
    const source = makeSource(
      { ses_1: ['frm_a'] },
      { ses_2: ['per_a', 'per_b'] },
    );
    const result = await detectPendingRequests(source, ['ses_1', 'ses_2', 'ses_3']);
    expect(result.forms).toBe(1);
    expect(result.permissions).toBe(2);
    expect(result.sessions.sort()).toEqual(['ses_1', 'ses_2']);
    expect(result.incomplete).toBe(false);
  });

  it('查询失败 ⇒ incomplete=true（结论不完整 ⇒ 不得放行重载）', async () => {
    const source = makeSource({ ses_1: ['frm_a'] }, {}, ['ses_2']);
    const result = await detectPendingRequests(source, ['ses_1', 'ses_2']);
    expect(result.incomplete).toBe(true);
    // 查得到的会话照常统计
    expect(result.forms).toBe(1);
  });

  it('空串与重复会话 id 被忽略（不重复查询）', async () => {
    const listQuestions = jest.fn().mockResolvedValue([]);
    const source: PendingRequestSource = {
      listQuestions,
      listPermissions: async () => [],
    };
    await detectPendingRequests(source, ['', '  ', 'ses_1', 'ses_1']);
    expect(listQuestions).toHaveBeenCalledTimes(1);
  });

  it('会话集合为空 ⇒ 不发任何请求', async () => {
    const listQuestions = jest.fn().mockResolvedValue([]);
    const source: PendingRequestSource = {
      listQuestions,
      listPermissions: async () => [],
    };
    const result = await detectPendingRequests(source, []);
    expect(listQuestions).not.toHaveBeenCalled();
    expect(result.incomplete).toBe(false);
  });
});

describe('fetchPendingForms / fetchPendingPermissions（唯一「怎么问」的实现）', () => {
  it('透传驱动的结果', async () => {
    const source = makeSource({ ses_1: ['frm_a'] }, { ses_1: ['per_a'] });
    expect((await fetchPendingForms(source, 'ses_1')).map((q) => q.id)).toEqual(['frm_a']);
    expect((await fetchPendingPermissions(source, 'ses_1')).map((p) => p.id)).toEqual(['per_a']);
  });

  it('失败抛错（调用方据此标记结论不完整）', async () => {
    const source = makeSource({}, {}, ['ses_x']);
    await expect(fetchPendingForms(source, 'ses_x')).rejects.toThrow('query failed');
    await expect(fetchPendingPermissions(source, 'ses_x')).rejects.toThrow('query failed');
  });
});
