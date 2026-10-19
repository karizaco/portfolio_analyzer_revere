with open('tools/qmg_ocr_results.html') as f:
    content = f.read()
lines = content.split('\n')
for i, line in enumerate(lines):
    if 'img src' in line and 'r.snapRel' in line:
        print('Line', i, ':')
        for j, c in enumerate(line):
            if ord(c) > 127 or c in list('$`\\'):
                print('  pos', j, repr(c), 'ord=', ord(c))
        break
