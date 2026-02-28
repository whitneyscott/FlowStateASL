export interface SproutPlaylist {
  id: string;
  title: string;
  videos?: string[];
  updated_at?: string;
}

export interface SproutPlaylistListItem {
  title: string;
  id?: string;
}
