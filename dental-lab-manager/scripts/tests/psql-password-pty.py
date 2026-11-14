#!/usr/bin/env python3
"""LOCAL TEST HELPER: drives `psql -X <url>` + `\\password <role>` through a
pseudo-terminal, exactly as a person would type it in Termux. The new password
is read from the environment variable NEW_ROLE_PASSWORD (never from argv) and
the admin password from PGPASSWORD. Prints nothing secret.

usage: NEW_ROLE_PASSWORD=… PGPASSWORD=… python3 -I psql-password-pty.py <db-url> <role>
"""
import os
import pty
import sys
import time

url, role = sys.argv[1], sys.argv[2]
new = os.environ['NEW_ROLE_PASSWORD']
pid, fd = pty.fork()
if pid == 0:
    os.execvp('psql', ['psql', '-X', url])

buf = b''


def read_until(token, timeout=15):
    global buf
    end = time.time() + timeout
    while token not in buf:
        if time.time() > end:
            raise SystemExit('timeout waiting for psql prompt')
        try:
            chunk = os.read(fd, 1024)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
    data, buf = buf, b''
    return data


read_until(b'=>') if b'=>' in buf else read_until(b'=')
os.write(fd, f'\\password {role}\n'.encode())
read_until(b'password')
os.write(fd, (new + '\n').encode())
read_until(b'gain')
os.write(fd, (new + '\n').encode())
time.sleep(1)
os.write(fd, b'\\q\n')
try:
    while os.read(fd, 1024):
        pass
except OSError:
    pass
_, status = os.waitpid(pid, 0)
print('psql \\password finished, exit status', os.waitstatus_to_exitcode(status))
