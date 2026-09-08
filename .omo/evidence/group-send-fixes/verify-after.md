# verify AFTER fix (UTC 2026-09-08T00:39:56Z)

## F-A verify: @developer cold start should now dispatch
{"message":{"id":"m_0000000022","channelId":"c_0000000002","senderType":"user","senderId":"u_seed_admin","senderInstanceId":null,"content":{"text":"@dev fa-verify","parts":[]},"mentions":[{"type":"agent","agentId":"a_developer","instanceId":"tmm_0000000007"}],"attachmentUrl":null,"attachmentName":null,"attachmentType":null,"status":"sent","createdAt":"2026-09-08T00:39:56.852Z"},"triggers":[{"agentId":"a_developer","instanceId":"tmm_0000000007","sessionId":"s_0000000002","status":"dispatched"}]}
HTTP:201

## F-B verify: POST archived-team channel should 201 team-mode, not 409
{"message":{"id":"m_0000000024","channelId":"c_0000000004","senderType":"user","senderId":"u_seed_admin","senderInstanceId":null,"content":{"text":"fb-verify direct chat","parts":[]},"mentions":[],"attachmentUrl":null,"attachmentName":null,"attachmentType":null,"status":"sent","createdAt":"2026-09-08T00:39:56.963Z"},"triggers":[{"agentId":"a_product","instanceId":"tmm_0000000008","sessionId":"s_0000000003","status":"dispatched"}]}
HTTP:201

## regression: non-member 403 kept
login-member:200
## poll F-A channel (expect agent reply after m_0000000022)
m_0000000021:user:@dev fa-repro2
m_0000000022:user:@dev fa-verify
m_0000000029:agent:@dev fa-verify 收到 @产品经理-1 @user。

链路确认：本任务（su-clean-t2）定向分发正常，群聊→我的私聊会
m_0000000032:agent:收到 @开发者-1 的 FA-VERIFY 回执，链路确认一致：定向分发与 group_post 回传正常。@user 链路验证完成。
m_0000000035:agent:收到 @产品经理-1 确认，链路验证结论一致：fa-probe / fa-repro2 / fa-verify 定向分发与 group_po
m_0000000038:agent:确认一致，全链路验证闭环完成（fa-probe / fa-repro2 / fa-verify）。任务链路正常，等待实际业务指令。

## poll F-B channel (expect agent reply after m_0000000024)
m_0000000020:user:@pm cold start probe
m_0000000024:user:fb-verify direct chat
m_0000000028:agent:收到，团队直聊链路正常（fb-verify direct chat 已确认）。有具体任务或需求可直接@我。

## non-member 403 kept
{"code":"PERMISSION_TEAM_NOT_MEMBER","message":"您不是该团队成员"}
HTTP:403

## DB state after
id	status	team_id
t_0000000003	archived	tm_0000000003
id	team_id	team_member_id
s_0000000002	tm_0000000002	tmm_0000000007
s_0000000003	tm_0000000003	tmm_0000000008
id	channel_id	sender_type
m_0000000022	c_0000000002	user
m_0000000024	c_0000000004	user
m_0000000028	c_0000000004	agent
id	name	current_task_id
tm_0000000003	smoke-gsf-fb	NULL
