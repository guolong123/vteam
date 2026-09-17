-- Agent hook 域（trigger-unification todo-11，加法-only）
-- 用途：agent 注册"稍后唤醒我"（time 定时 / all_idle 全队静默），到期经
-- workerDispatcher.dispatchAgentMention(kind:'wake') 在同会话内唤醒。
-- time hook：注册时同事务落 hook_fire 触发器行（dueAt 到期唤醒）。
-- all_idle hook：不做 per-hook 轮询，由全局 hook_poll interval 行
-- （dedupKey `hook_poll:global:all_idle`，HookService.onModuleInit 幂等确保）
-- 统一扫描评估；到期兜底 hook_fire 行定于 expiresAt（触发时仅做过期结算）。
-- 状态机：pending → fired（唤醒成功）/ expired（目标失效或过期，永不抛错，
-- 永不静默消失）/ cancelled（hook_cancel 显式取消，永不触发）。
-- hook/trigger 关联：逻辑关联不建 FK；hook_fire 行 payload.hookId +
-- dedupKey `hook_fire:hook:<hookId>` 可回查（todo-3 reconciler 位）。
-- 血缘：parent_hook_id 指向上游 hook，root_task_id 继承不重置；
-- resetAfterComplete 只把 completed task 的 hooks 标 expired（updateMany，
-- 永不 DELETE，跨任务环检测链不断）。
CREATE TABLE `hooks` (
    `id` VARCHAR(191) NOT NULL,
    `scope_type` VARCHAR(191) NOT NULL,
    `scope_id` VARCHAR(191) NOT NULL,
    `owner_instance_id` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `wake_text` TEXT NOT NULL,
    `target` JSON NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `due_at` DATETIME(3) NULL,
    `grace_ms` INTEGER NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `dedup_key` VARCHAR(191) NOT NULL,
    `fire_count` INTEGER NOT NULL DEFAULT 0,
    `parent_hook_id` VARCHAR(191) NULL,
    `root_task_id` VARCHAR(191) NULL,
    `last_error` VARCHAR(191) NULL,
    `skip_reason` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `hooks_dedup_key_key`(`dedup_key`),
    INDEX `idx_hooks_status_due_at`(`status`, `due_at`),
    INDEX `idx_hooks_status_scope`(`status`, `scope_type`, `scope_id`),
    INDEX `idx_hooks_status_kind`(`status`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
