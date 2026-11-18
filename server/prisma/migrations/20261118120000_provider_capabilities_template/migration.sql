-- provider 级默认模型能力模板（2026-11-18）
--
-- 背景：模型入库是自动的（worker 上报 capabilities.models 字符串数组 → upsertCatalogModel），
-- 拿不到能力信息；上游 /models 也不保证返回 vision 能力（commandcode 实测只返回
-- id/context_length/supported_endpoints）。结果模型行 capabilities=NULL，
-- worker 写 opencode 配置时 input=["text"]，agent 侧读不了图片，只能人工逐模型补。
--
-- 语义：模型行自身 capabilities 优先；未声明时继承本模板。修改模板回填未自定义的行。
-- 与 baseUrl/provider_type/headers 同一套「provider 级字段存 model 行」模式。

ALTER TABLE `models`
  ADD COLUMN `provider_capabilities` JSON NULL;
