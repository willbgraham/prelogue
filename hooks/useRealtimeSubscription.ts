import { useEffect } from "react";
import { supabase } from "@/lib/supabase";

type PostgresChange = {
  event: "INSERT" | "UPDATE" | "DELETE";
  schema: string;
  table: string;
  filter?: string;
};

/**
 * Subscribe to Supabase realtime changes on a table.
 * Automatically cleans up on unmount.
 */
export function useRealtimeSubscription(
  channelName: string,
  change: PostgresChange,
  callback: (payload: any) => void
) {
  useEffect(() => {
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes" as any,
        {
          event: change.event,
          schema: change.schema,
          table: change.table,
          filter: change.filter,
        },
        callback
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [channelName, change.table, change.filter]);
}

/**
 * Subscribe to multiple realtime changes on a single channel.
 */
export function useRealtimeMulti(
  channelName: string,
  subscriptions: { change: PostgresChange; callback: (payload: any) => void }[]
) {
  useEffect(() => {
    let channel = supabase.channel(channelName);

    for (const sub of subscriptions) {
      channel = channel.on(
        "postgres_changes" as any,
        {
          event: sub.change.event,
          schema: sub.change.schema,
          table: sub.change.table,
          filter: sub.change.filter,
        },
        sub.callback
      );
    }

    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [channelName]);
}
