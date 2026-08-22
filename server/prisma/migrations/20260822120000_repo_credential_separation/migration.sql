-- Drop existing tables (destructive, no legacy compat as per requirement)
DROP TABLE IF EXISTS `git_repo_grants`;
DROP TABLE IF EXISTS `git_credentials`;

-- Create new git_credentials (credential pool)
CREATE TABLE `git_credentials` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `auth_type` VARCHAR(191) NOT NULL,
    `credential_ref` TEXT NOT NULL,
    `fingerprint` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `created_by` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    UNIQUE INDEX `git_credentials_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create git_repos
CREATE TABLE `git_repos` (
    `id` VARCHAR(191) NOT NULL,
    `repo_url` VARCHAR(191) NOT NULL,
    `credential_id` VARCHAR(191) NOT NULL,
    `created_by` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    UNIQUE INDEX `git_repos_repo_url_key`(`repo_url`),
    INDEX `idx_git_repos_credential`(`credential_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create git_repo_grants with repo_id
CREATE TABLE `git_repo_grants` (
    `id` VARCHAR(191) NOT NULL,
    `agent_id` VARCHAR(191) NOT NULL,
    `repo_id` VARCHAR(191) NOT NULL,
    `permission` VARCHAR(191) NOT NULL,
    `effect` VARCHAR(191) NOT NULL,
    `granted_by` VARCHAR(191) NOT NULL,
    `granted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revoked_at` DATETIME(3) NULL,
    INDEX `idx_git_repo_grants_agent`(`agent_id`),
    INDEX `idx_git_repo_grants_repo`(`repo_id`),
    UNIQUE INDEX `uk_git_repo_grants_agent_repo`(`agent_id`, `repo_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
