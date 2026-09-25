export enum GameState {
  LOBBY,
  TASKS,
  DISCUSSION,
  MENU,
  UNKNOWN,
}

export type Player = {
  id: number;
  clientId: number;
  name: string;
  nameHash: number;
  colorId?: number;
  playerConfigId?: number;
  friendCode?: string;
  playerUid?: string;
  playerIdentifier?: string;
  disconnected: boolean;
  isImpostor: boolean;
  isDead: boolean;
  bugged: boolean;
  x: number;
  y: number;
  inVent: boolean;
  isDummy: boolean;
};

export type AmongUsState = {
  gameState: GameState;
  oldGameState: GameState;
  lobbyCode: string;
  players: Player[];
  hostId: number;
  comsSabotaged: boolean;
  lightRadius: number;
  lightRadiusChanged: boolean;
};

export type LobbySettings = {
  maxDistance: number;
  visionHearing: boolean;
  haunting: boolean;
  hearImpostorsInVents: boolean;
  impostersHearImpostersInvent: boolean;
  impostorRadioEnabled: boolean;
  impostorRadioPrivate: boolean;
  commsSabotage: boolean;
  deadOnly: boolean;
  meetingGhostOnly: boolean;
  hearThroughCameras: boolean;
  wallsBlockAudio: boolean;
};

export const defaultLobbySettings: LobbySettings = {
  maxDistance: 5.32,
  visionHearing: false,
  haunting: false,
  hearImpostorsInVents: false,
  impostersHearImpostersInvent: false,
  impostorRadioEnabled: false,
  impostorRadioPrivate: false,
  commsSabotage: false,
  deadOnly: false,
  meetingGhostOnly: false,
  hearThroughCameras: false,
  wallsBlockAudio: false,
};

export type ClientIdentity = {
  playerId: number;
  clientId: number;
};

export type MobileHostPayload = {
  gameState: AmongUsState;
  lobbySettings?: Partial<LobbySettings>;
};

export type ClientPeerConfig = {
  forceRelayOnly: boolean;
  iceServers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
};
