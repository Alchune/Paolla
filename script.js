document.getElementById('zakrjna-form').addEventListener('submit', function(event) {
    event.preventDefault();

    let naradNumber = document.getElementById('narad-number').value;
    let model = document.getElementById('model').value;
    let quantity = document.getElementById('quantity').value;

    let newItem = document.createElement('li');
    newItem.innerHTML = `Наряд: ${naradNumber}, Модель: ${model}, Кількість: ${quantity} <button onclick="moveToShvejna(this)">Готово</button>`;

    document.getElementById('zakrjna-list').appendChild(newItem);

    document.getElementById('zakrjna-form').reset();
});

function moveToShvejna(button) {
    let item = button.parentElement;
    item.removeChild(button);
    item.innerHTML += ' <button onclick="moveToZatjazhka(this)">Готово</button>';
    document.getElementById('shvejna-list').appendChild(item);
}

function moveToZatjazhka(button) {
    let item = button.parentElement;
    item.removeChild(button);
    item.innerHTML += ' <button onclick="moveToGotovo(this)">Готово</button>';
    document.getElementById('zatjazhka-list').appendChild(item);
}

function moveToGotovo(button) {
    let item = button.parentElement;
    item.removeChild(button);
    document.getElementById('gotovo-list').appendChild(item);
}
