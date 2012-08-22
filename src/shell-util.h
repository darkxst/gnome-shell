/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#ifndef __SHELL_UTIL_H__
#define __SHELL_UTIL_H__

#include <gio/gio.h>
#include <clutter/clutter.h>
#include <libsoup/soup.h>
#include <gdk-pixbuf/gdk-pixbuf.h>

G_BEGIN_DECLS

char    *shell_util_get_label_for_uri          (const char       *text_uri);
GIcon   *shell_util_get_icon_for_uri           (const char       *text_uri);

void     shell_util_set_hidden_from_pick       (ClutterActor     *actor,
                                                gboolean          hidden);

void     shell_util_get_transformed_allocation (ClutterActor     *actor,
                                                ClutterActorBox  *box);

int      shell_util_get_week_start             (void);

char    *shell_util_normalize_and_casefold     (const char       *str);

char    *shell_util_format_date                (const char       *format,
                                                gint64            time_ms);

gboolean shell_write_string_to_stream          (GOutputStream    *stream,
                                                const char       *str,
                                                GError          **error);

char    *shell_get_file_contents_utf8_sync     (const char       *path,
                                                GError          **error);

gboolean shell_session_is_active_for_systemd (void);

gboolean shell_util_wifexited                  (int               status,
                                                int              *exit);

GdkPixbuf *shell_util_create_pixbuf_from_data (const guchar      *data,
                                               gsize              len,
                                               GdkColorspace      colorspace,
                                               gboolean           has_alpha,
                                               int                bits_per_sample,
                                               int                width,
                                               int                height,
                                               int                rowstride);

G_END_DECLS

#endif /* __SHELL_UTIL_H__ */
