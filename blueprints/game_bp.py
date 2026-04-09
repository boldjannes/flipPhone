"""
Game blueprint – Game of Skate.
Mounted at /.
"""

from flask import Blueprint, render_template

game = Blueprint('game', __name__)


@game.route('/')
def index():
    return render_template('game/index.html')
