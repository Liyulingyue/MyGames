/**
 * 大厅前端统一连接状态。
 * 实现已收敛到 @lobby/game-sdk（packages/game-sdk），本文件仅保留旧导入路径的垫片。
 * 新代码请直接从 game-sdk 导入。
 */
import { createLobbyStore } from '../../packages/game-sdk/src/index'

export const useGameStore = createLobbyStore()

export type {
  WSMessage,
  MessageType,
  RoomPlayer,
  MatchFoundInfo,
  RoomStateInfo,
  ErrorInfo,
  LobbyClient,
  LobbyStoreState,
} from '../../packages/game-sdk/src/index'
