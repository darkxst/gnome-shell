// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

function listDirAsync(file, callback) {
    let allFiles = [];
    file.enumerate_children_async(Gio.FILE_ATTRIBUTE_STANDARD_NAME,
                                  Gio.FileQueryInfoFlags.NONE,
                                  GLib.PRIORITY_LOW, null, function (obj, res) {
        let enumerator = obj.enumerate_children_finish(res);
        function onNextFileComplete(obj, res) {
            let files = obj.next_files_finish(res);
            if (files.length) {
                allFiles = allFiles.concat(files);
                enumerator.next_files_async(100, GLib.PRIORITY_LOW, null, onNextFileComplete);
            } else {
                enumerator.close(null);
                callback(allFiles);
            }
        }
        enumerator.next_files_async(100, GLib.PRIORITY_LOW, null, onNextFileComplete);
    });
}

function deleteGFile(file) {
    // Work around 'delete' being a keyword in JS.
    return file['delete'](null);
}

function recursivelyDeleteDir(dir, deleteParent) {
    let children = dir.enumerate_children('standard::name,standard::type',
                                          Gio.FileQueryInfoFlags.NONE, null);

    let info, child;
    while ((info = children.next_file(null)) != null) {
        let type = info.get_file_type();
        let child = dir.get_child(info.get_name());
        if (type == Gio.FileType.REGULAR)
            deleteGFile(child);
        else if (type == Gio.FileType.DIRECTORY)
            recursivelyDeleteDir(child, true);
    }

    if (deleteParent)
        deleteGFile(dir);
}

function recursivelyMoveDir(srcDir, destDir) {
    let children = srcDir.enumerate_children('standard::name,standard::type',
                                             Gio.FileQueryInfoFlags.NONE, null);

    if (!destDir.query_exists(null))
        destDir.make_directory_with_parents(null);

    let info, child;
    while ((info = children.next_file(null)) != null) {
        let type = info.get_file_type();
        let srcChild = srcDir.get_child(info.get_name());
        let destChild = destDir.get_child(info.get_name());
        log([srcChild.get_path(), destChild.get_path()]);
        if (type == Gio.FileType.REGULAR)
            srcChild.move(destChild, Gio.FileCopyFlags.NONE, null, null);
        else if (type == Gio.FileType.DIRECTORY)
            recursivelyMoveDir(srcChild, destChild);
    }
}
