/**
 * 模型目录 API 封装（可用模型下拉的**全量**取数）。
 * =============================================
 * 背景：服务端 `GET /models` 的 `pageSize` 上限是 100（`server/src/common/pagination.ts`
 * 的 MAX_PAGE_SIZE），传 `pageSize=200` 会被静默压到 100。而 `findAll` 按
 * `createdAt asc` 排序，**新入库的模型排在后面**——只取第 1 页会让下拉永远看不到新模型
 * （实测线上 hy4-flash-free 排在第 201~254 条，被第一页截断）。
 *
 * 本工具逐页拉取直到取完 `total`，返回扁平数组；各下拉统一用它，避免每个调用点
 * 各自复制「page=1&pageSize=200」的错误写法。
 */
import { api } from "@/lib/api";

/** 下拉候选项：服务端返回完整 Model 行，此处只声明消费端需要的子集。 */
export interface AvailableModelOption {
  id: string;
  name: string;
  providerID: string;
  modelID?: string;
}

interface AvailableModelsPage {
  items: AvailableModelOption[];
  total: number;
  page: number;
  pageSize: number;
}

/** 对齐服务端 MAX_PAGE_SIZE，避免再被静默截断。 */
const PAGE_SIZE = 100;

/**
 * 逐页拉取全部 `available=1` 模型（扁平数组）。
 *
 * 每页刷新 `total`，容忍并发新增；空页即停，防死循环。
 */
export async function fetchAllAvailableModels(): Promise<AvailableModelOption[]> {
  const all: AvailableModelOption[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  while (all.length < total) {
    const res = await api.get<AvailableModelsPage>("/models", {
      query: { page, pageSize: PAGE_SIZE, available: 1 },
    });
    if (!res.items?.length) break;
    all.push(...res.items);
    total = res.total ?? 0;
    page += 1;
  }
  return all;
}
