import { request, request_stream } from '../YouTube/utils/request';
import { PassThrough } from 'stream';
import { IncomingMessage } from 'http';
import { StreamType } from '../YouTube/stream';

interface SoundCloudUser {
    name: string;
    id: string;
    url: string;
    type: 'track' | 'playlist' | 'user';
    verified: boolean;
    description: string;
    first_name: string;
    full_name: string;
    last_name: string;
    thumbnail: string;
}

interface SoundCloudTrackDeprecated {
    fetched: boolean;
    id: number;
    type: 'track';
}

interface SoundCloudTrackFormat {
    url: string;
    preset: string;
    duration: number;
    format: {
        protocol: string;
        mime_type: string;
    };
    quality: string;
}

export class SoundCloudTrack {
    name: string;
    id: number;
    url: string;
    fetched: boolean;
    type: 'track' | 'playlist' | 'user';
    durationInSec: number;
    durationInMs: number;
    formats: SoundCloudTrackFormat[];
    publisher: {
        name: string;
        id: number;
        artist: string;
        contains_music: boolean;
        writer_composer: string;
    } | null;
    thumbnail: string;
    user: SoundCloudUser;
    constructor(data: any) {
        this.name = data.title;
        this.id = data.id;
        this.url = data.uri;
        this.fetched = true;
        this.type = 'track';
        this.durationInSec = Number(data.duration) / 1000;
        this.durationInMs = Number(data.duration);
        if (data.publisher_metadata)
            this.publisher = {
                name: data.publisher_metadata.publisher,
                id: data.publisher_metadata.id,
                artist: data.publisher_metadata.artist,
                contains_music: Boolean(data.publisher_metadata.contains_music) || false,
                writer_composer: data.publisher_metadata.writer_composer
            };
        else this.publisher = null;
        this.formats = data.media.transcodings;
        this.user = {
            name: data.user.username,
            id: data.user.id,
            type: 'user',
            url: data.user.permalink_url,
            verified: Boolean(data.user.verified) || false,
            description: data.user.description,
            first_name: data.user.first_name,
            full_name: data.user.full_name,
            last_name: data.user.last_name,
            thumbnail: data.user.avatar_url
        };
        this.thumbnail = data.artwork_url;
    }

    toJSON() {
        return {
            name: this.name,
            id: this.id,
            type: this.type,
            url: this.url,
            fetched : this.fetched,
            durationInMs: this.durationInMs,
            durationInSec: this.durationInSec,
            publisher: this.publisher,
            formats: this.formats,
            thumbnail: this.thumbnail,
            user : this.user
        };
    }
}

export class SoundCloudPlaylist {
    name: string;
    id: number;
    url: string;
    type: 'track' | 'playlist' | 'user';
    sub_type: string;
    durationInSec: number;
    durationInMs: number;
    client_id: string;
    user: SoundCloudUser;
    tracks: SoundCloudTrack[] | SoundCloudTrackDeprecated[];
    tracksCount: number;
    constructor(data: any, client_id: string) {
        this.name = data.title;
        this.id = data.id;
        this.url = data.uri;
        this.client_id = client_id;
        this.type = 'playlist';
        this.sub_type = data.set_type;
        this.durationInSec = Number(data.duration) / 1000;
        this.durationInMs = Number(data.duration);
        this.user = {
            name: data.user.username,
            id: data.user.id,
            type: 'user',
            url: data.user.permalink_url,
            verified: Boolean(data.user.verified) || false,
            description: data.user.description,
            first_name: data.user.first_name,
            full_name: data.user.full_name,
            last_name: data.user.last_name,
            thumbnail: data.user.avatar_url
        };
        this.tracksCount = data.track_count;
        const tracks: any[] = [];
        data.tracks.forEach((track: any) => {
            if (track.title) {
                tracks.push(new SoundCloudTrack(track));
            } else
                tracks.push({
                    id: track.id,
                    fetched: false,
                    type: 'track'
                });
        });
        this.tracks = tracks;
    }

    async fetch(): Promise<void> {
        const work: any[] = [];
        for (let i = 0; i < this.tracks.length; i++) {
            if (!this.tracks[i].fetched) {
                work.push(
                    new Promise(async (resolve) => {
                        const num = i;
                        const data = await request(
                            `https://api-v2.soundcloud.com/tracks/${this.tracks[i].id}?client_id=${this.client_id}`
                        );

                        this.tracks[num] = new SoundCloudTrack(JSON.parse(data));
                        resolve('');
                    })
                );
            }
        }
        await Promise.allSettled(work);
    }

    get total_tracks(){
        let count = 0
        this.tracks.forEach((track) => {
            if(track instanceof SoundCloudTrack) count++
            else return
        })
        return count
    }

    toJSON() {
        return {
            name: this.name,
            id: this.id,
            type: this.type,
            sub_type : this.sub_type,
            url: this.url,
            durationInMs: this.durationInMs,
            durationInSec: this.durationInSec,
            tracksCount : this.tracksCount,
            user : this.user,
            tracks : this.tracks
        };
    }
}

export class Stream {
    stream : PassThrough;
    type: StreamType;
    private url: string;
    private playing_count: number;
    private downloaded_time: number;
    private downloaded_segments: number;
    private request: IncomingMessage | null;
    private data_ended: boolean;
    private time: number[];
    private segment_urls: string[];
    constructor(url: string, type: StreamType = StreamType.Arbitrary) {
        this.stream = new PassThrough({ highWaterMark: 10 * 1000 * 1000 });
        this.type = type;
        this.url = url;
        this.playing_count = 0;
        this.downloaded_time = 0;
        this.request = null;
        this.downloaded_segments = 0;
        this.data_ended = false;
        this.time = [];
        this.segment_urls = [];
        this.stream.on('close', () => {
            this.cleanup();
        });
        this.stream.on('pause', () => {
            this.playing_count++;
            if (this.data_ended) {
                this.cleanup();
                this.stream.removeAllListeners('pause');
            } else if (this.playing_count === 110) {
                this.playing_count = 0;
                this.start();
            }
        });
        this.start();
    }

    private async parser() {
        const response = await request(this.url).catch((err: Error) => {
            return err;
        });
        if (response instanceof Error) throw response;
        const array = response.split('\n');
        array.forEach((val) => {
            if (val.startsWith('#EXTINF:')) {
                this.time.push(parseFloat(val.replace('#EXTINF:', '')));
            } else if (val.startsWith('https')) {
                this.segment_urls.push(val);
            }
        });
        return;
    }

    private async start() {
        if (this.stream.destroyed) {
            this.cleanup();
            return;
        }
        this.time = [];
        this.segment_urls = [];
        await this.parser();
        this.downloaded_time = 0;
        this.segment_urls.splice(0, this.downloaded_segments);
        this.loop();
    }

    private async loop() {
        if (this.stream.destroyed) {
            this.cleanup();
            return;
        }
        if (this.time.length === 0 || this.segment_urls.length === 0) {
            this.data_ended = true;
            return;
        }
        this.downloaded_time += this.time.shift() as number;
        this.downloaded_segments++;
        const stream = await request_stream(this.segment_urls.shift() as string).catch((err: Error) => err);
        if (stream instanceof Error) throw stream;

        stream.pipe(this.stream, { end: false });
        stream.on('end', () => {
            if (this.downloaded_time >= 300) return;
            else this.loop();
        });
        stream.once('error', (err) => {
            this.stream.emit('error', err);
        });
    }

    private cleanup() {
        this.request?.unpipe(this.stream);
        this.request?.destroy();
        this.url = '';
        this.playing_count = 0;
        this.downloaded_time = 0;
        this.downloaded_segments = 0;
        this.request = null;
        this.time = [];
        this.segment_urls = [];
    }
}