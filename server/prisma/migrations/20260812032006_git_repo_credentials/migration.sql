-- CreateTable
CREATE TABLE `git_credentials` (
    `id` VARCHAR(191) NOT NULL,
    `repo_url` VARCHAR(191) NOT NULL,
    `auth_type` VARCHAR(191) NOT NULL,
    `credential_ref` TEXT NOT NULL,
    `fingerprint` VARCHAR(191) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,

    UNIQUE INDEX `uk_git_credentials_repo_auth`(`repo_url`, `auth_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `git_repo_grants` (
    `id` VARCHAR(191) NOT NULL,
    `agent_id` VARCHAR(191) NOT NULL,
    `repo_url` VARCHAR(191) NOT NULL,
    `permission` VARCHAR(191) NOT NULL,
    `effect` VARCHAR(191) NOT NULL,
    `granted_by` VARCHAR(191) NOT NULL,
    `granted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revoked_at` DATETIME(3) NULL,

    INDEX `idx_git_repo_grants_agent`(`agent_id`),
    INDEX `idx_git_repo_grants_repo`(`repo_url`),
    UNIQUE INDEX `uk_git_repo_grants_agent_repo`(`agent_id`, `repo_url`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
