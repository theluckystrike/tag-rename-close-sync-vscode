# Close tags as you type

- Type `>` after `<div class="x"` and you get `</div>` after the cursor.
- Type `</` and the name of the open element is filled in.

It never closes:

- void tags such as `<br>`, `<img>`, `<input>` and `<meta>`
- TypeScript generics such as `Array<string>` or `Observable<boolean>`
- anything inside comments, strings, `<script>` and `<style>` bodies, `{{ }}`, `{% %}` or `<?php ?>` blocks

In HTML and JSX, VS Code closes tags itself, and the Vue, Svelte, Astro and XML extensions do too. Then this extension leaves closing to them, so you never get two closing tags.
