import { Logger } from '@nestjs/common/services/logger.service';
import { loadPackage } from '@nestjs/common/utils/load-package.util';
import { fromEvent, merge, Subject, zip } from 'rxjs';
import { share, take, tap } from 'rxjs/operators';
import {
  CONNECT_EVENT,
  ERROR_EVENT,
  MESSAGE_EVENT,
  REDIS_DEFAULT_URL,
} from '../constants';
import {
  ClientOpts,
  RedisClient,
  RetryStrategyOptions,
} from '../external/redis.interface';
import { ReadPacket, RedisOptions, WritePacket } from '../interfaces';
import { ClientProxy } from './client-proxy';
import { ECONNREFUSED } from './constants';

let redisPackage: any = {};

export class ClientRedis extends ClientProxy {
  protected readonly logger = new Logger(ClientProxy.name);
  protected readonly url: string;
  protected pubClient: RedisClient;
  protected subClient: RedisClient;
  protected connection: Promise<any>;
  protected isExplicitlyTerminated = false;

  constructor(protected readonly options: RedisOptions['options']) {
    super();
    this.url = this.getOptionsProp(options, 'url') || REDIS_DEFAULT_URL;

    redisPackage = loadPackage('redis', ClientRedis.name, () =>
      require('redis'),
    );

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  public getAckPatternName(pattern: string): string {
    return `${pattern}_ack`;
  }

  public getResPatternName(pattern: string): string {
    return `${pattern}_res`;
  }

  public close() {
    this.pubClient && this.pubClient.quit();
    this.subClient && this.subClient.quit();
    this.pubClient = this.subClient = null;
    this.isExplicitlyTerminated = true;
  }

  public connect(): Promise<any> {
    if (this.pubClient && this.subClient) {
      return this.connection;
    }
    const error$ = new Subject<Error>();

    this.pubClient = this.createClient(error$);
    this.subClient = this.createClient(error$);
    this.handleError(this.pubClient);
    this.handleError(this.subClient);

    const pubConnect$ = fromEvent(this.pubClient, CONNECT_EVENT);
    const subClient$ = fromEvent(this.subClient, CONNECT_EVENT);

    this.connection = merge(error$, zip(pubConnect$, subClient$))
      .pipe(
        take(1),
        tap(() =>
          this.subClient.on(MESSAGE_EVENT, this.createResponseCallback()),
        ),
        share(),
      )
      .toPromise();
    return this.connection;
  }

  public createClient(error$: Subject<Error>): RedisClient {
    return redisPackage.createClient({
      ...this.getClientOptions(error$),
      url: this.url,
    });
  }

  public handleError(client: RedisClient) {
    client.addListener(ERROR_EVENT, (err: any) => this.logger.error(err));
  }

  public getClientOptions(error$: Subject<Error>): Partial<ClientOpts> {
    const retry_strategy = (options: RetryStrategyOptions) =>
      this.createRetryStrategy(options, error$);
    return {
      retry_strategy,
    };
  }

  public createRetryStrategy(
    options: RetryStrategyOptions,
    error$: Subject<Error>,
  ): undefined | number | Error {
    if (options.error && (options.error as any).code === ECONNREFUSED) {
      error$.error(options.error);
    }
    if (this.isExplicitlyTerminated) {
      return undefined;
    }
    if (
      !this.getOptionsProp(this.options, 'retryAttempts') ||
      options.attempt > this.getOptionsProp(this.options, 'retryAttempts')
    ) {
      return new Error('Retry time exhausted');
    }
    return this.getOptionsProp(this.options, 'retryDelay') || 0;
  }

  public createResponseCallback(): (channel: string, buffer: string) => void {
    return (channel: string, buffer: string) => {
      const packet = JSON.parse(buffer);
      const { err, response, isDisposed, id } = this.deserializer.deserialize(
        packet,
      );

      const callback = this.routingMap.get(id);
      if (!callback) {
        return;
      }
      if (isDisposed || err) {
        return callback({
          err,
          response,
          isDisposed: true,
        });
      }
      callback({
        err,
        response,
      });
    };
  }

  protected publish(
    partialPacket: ReadPacket,
    callback: (packet: WritePacket) => any,
  ): Function {
    try {
      const packet = this.assignPacketId(partialPacket);
      const pattern = this.normalizePattern(partialPacket.pattern);
      const serializedPacket = this.serializer.serialize(packet);
      const responseChannel = this.getResPatternName(pattern);

      this.routingMap.set(packet.id, callback);
      this.subClient.subscribe(responseChannel, (err: any) => {
        if (err) {
          return;
        }
        this.pubClient.publish(
          this.getAckPatternName(pattern),
          JSON.stringify(serializedPacket),
        );
      });

      return () => {
        this.subClient.unsubscribe(responseChannel);
        this.routingMap.delete(packet.id);
      };
    } catch (err) {
      callback({ err });
    }
  }

  protected dispatchEvent(packet: ReadPacket): Promise<any> {
    const pattern = this.normalizePattern(packet.pattern);
    const serializedPacket = this.serializer.serialize(packet);

    return new Promise((resolve, reject) =>
      this.pubClient.publish(pattern, JSON.stringify(serializedPacket), err =>
        err ? reject(err) : resolve(),
      ),
    );
  }
}
